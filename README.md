# InChat — anonymous voice rooms

Desktop voice-chat app built with **Electron + React**, with **everything
server-side on Cloudflare**: media via **RealtimeKit** (Core SDK, custom Discord-style UI), API + all
storage via a **Worker + D1**. Managed with **Bun**.

No user accounts: everyone joins anonymously with just a display name.
The Cloudflare API token lives only as a Worker secret — clients receive
nothing but their own per-guest participant `authToken`.

## Architecture

```
Desktop / browser client (Electron + React, custom voice UI)
        │  HTTPS (/api/*)
        ▼
Cloudflare Worker (`worker/`) ── secrets: account ID, API token, app ID
   ├─ POST /api/rooms            create meeting + mint participant token
   ├─ GET  /api/rooms            public room directory
   ├─ POST /api/rooms/:id/join   mint participant token
   ├─ GET/POST /api/rooms/:id/messages   chat history (persisted)
   └─ POST /api/webhooks/...     signed RealtimeKit events (live counts)
        │                    ▲
        ▼                    │ webhooks (verified RSA-SHA256)
Cloudflare D1 (`inchat`)     Cloudflare RealtimeKit (voice media)
 rooms · messages · processed_webhooks · meta
```

## Prerequisites

- [Bun](https://bun.sh) >= 1.1 (the Electron desktop shell bundles Chromium,
  so voice works there unlike Linux WebKitGTK WebViews)
- A Cloudflare account with:
  1. A **RealtimeKit app** (dash → Realtime → Kit → Create App).
  2. An API token with **Realtime / Realtime Admin** permission.
  3. A preset with meeting type **Voice** (e.g. `voice_participant`) — voice
     presets bill as audio-only participants.

## Setup

```sh
bun install
cd worker   # all wrangler commands run from here

# 1. D1 database (rooms, messages, webhook dedupe, key cache)
bunx wrangler d1 create inchat
#    paste the database_id into wrangler.toml
bunx wrangler d1 migrations apply inchat --local
bunx wrangler d1 migrations apply inchat --remote

# 2. Worker secrets (local dev file + production secrets)
cp .dev.vars.example .dev.vars   # fill in account/token/app
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID
bunx wrangler secret put CLOUDFLARE_API_TOKEN
bunx wrangler secret put CLOUDFLARE_APP_ID

# 3. Optional: Turnstile human check on room creation (dash → Turnstile →
#    Add widget, allow your worker/client hostnames). Then:
bunx wrangler secret put TURNSTILE_SECRET_KEY
#    and set VITE_TURNSTILE_SITE_KEY in the root .env (step 5). Until the
#    secret is set, creation works without the check (local dev).

# 3. Deploy
bunx wrangler deploy   # note the https://inchat-api.<you>.workers.dev URL
cd ..

# 4. Point the client at it
cp .env.example .env    # VITE_API_URL=https://inchat-api.<you>.workers.dev

# 5. Register webhooks so the room directory shows live occupancy
curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/realtime/kit/$APP_ID/webhooks" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "InChat directory",
    "url": "https://inchat-api.<you>.workers.dev/api/webhooks/realtimekit",
    "events": ["meeting.started", "meeting.ended",
               "meeting.participantJoined", "meeting.participantLeft"],
    "enabled": true
  }'
```

## Run

```sh
cd worker && bunx wrangler dev --port 8787   # :8787, Worker API (shell 1)
bun run dev          # :1420 — web client, /api proxied to the Worker (shell 2)
bun run dev:electron  # desktop shell against the same Worker API
bun run dist        # desktop AppImage (set VITE_API_URL in .env first)
```

Other scripts: `bun run check` (tsc), `bun run build` (web bundle only).

## How it works

- **Client** (`src/`, single screen, no landing page) — an always-visible
  sidebar (`Sidebar.tsx`: brand, public room directory, join-by-code,
  create form, editable display name) plus a stage that shows the active
  call or an empty state.
- **Room** (`src/components/Stage.tsx`, custom Discord-style UI on the
  Core SDK, no UI Kit) — channel header, voice grid with speaking rings,
  bottom control bar (mic/deafen/disconnect), live chat (`LiveChat.tsx`)
  plus saved D1 history (`History.tsx`, mirrored by `HistorySync`). Remote voices play through per-participant `<audio>`
  sinks (`RemoteAudio.tsx`). Initialized with
  `defaults: { audio: true, video: false }`. Leaving returns to the empty stage.
- **Worker** (`worker/src/index.ts`, zero dependencies, schema in
  `worker/migrations/`) — creates meetings, mints participant tokens, serves
  the directory and message history from D1, and applies signature-verified
  webhook events (deduplicated). Messages are kept indefinitely.
- **Abuse protection** — per-IP rate limits in the Worker (5 room
  creations/hour, 30 joins/10 min, 60 message writes/min, 180 reads/min),
  optional Turnstile check on creation, and rooms unlisted by default (only
  `isPublic` rooms appear in the directory; join-by-code always works).

## Project layout

```
src/                  React frontend (Vite)
  App.tsx             session state: empty stage ⇄ active call
  components/         Sidebar, Stage, LiveChat, RemoteAudio, History
  lib/provision.ts    Worker API client (VITE_API_URL or /api proxy)
worker/               Cloudflare Worker API + D1 + webhooks
electron/             Electron main + preload (Chromium shell; no backend logic — that's the Worker)
```
