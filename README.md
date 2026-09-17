# InChat — anonymous voice rooms

Desktop voice-chat app built with **Tauri + React**, with **everything
server-side on Cloudflare**: media via **RealtimeKit** (UI Kit), API + all
storage via a **Worker + D1**. Managed with **Bun**.

No user accounts: everyone joins anonymously with just a display name.
The Cloudflare API token lives only as a Worker secret — clients receive
nothing but their own per-guest participant `authToken`.

## Architecture

```
Desktop / browser client (Tauri + React + RtkMeeting UI Kit)
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

- [Bun](https://bun.sh) >= 1.1, Rust stable + Tauri webview libs for desktop
  builds ([prerequisites](https://tauri.app/start/prerequisites/))
- A Cloudflare account with:
  1. A **RealtimeKit app** (dash → Realtime → Kit → Create App).
  2. An API token with **Realtime / Realtime Admin** permission.
  3. A preset with meeting type **Voice** (e.g. `voice_participant`) — voice
     presets render the UI Kit's voice-only layout and bill as audio-only.

## Setup

```sh
bun install

# 1. D1 database (rooms, messages, webhook dedupe, key cache)
bunx wrangler d1 create inchat
#    paste the database_id into worker/wrangler.toml
bunx wrangler d1 migrations apply inchat --local
bunx wrangler d1 migrations apply inchat --remote

# 2. Worker secrets (local dev file + production secrets)
cp worker/.dev.vars.example worker/.dev.vars   # fill in account/token/app
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID
bunx wrangler secret put CLOUDFLARE_API_TOKEN
bunx wrangler secret put CLOUDFLARE_APP_ID

# 3. Optional: Turnstile human check on room creation (dash → Turnstile →
#    Add widget, allow your worker/client hostnames). Then:
bunx wrangler secret put TURNSTILE_SECRET_KEY
#    and set VITE_TURNSTILE_SITE_KEY in .env (step 5). Until the secret is
#    set, creation works without the check (local dev).

# 3. Deploy
bun run worker:deploy   # note the https://inchat-api.<you>.workers.dev URL

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
bun run worker:dev   # :8787 — Worker API with local .dev.vars (shell 1)
bun run dev          # :1420 — web client, /api proxied to the Worker (shell 2)
bun run tauri:dev    # desktop shell against the same Worker API
bun run tauri:build  # desktop bundle (set VITE_API_URL in .env first)
```

Other scripts: `bun run check` (tsc), `bun run build` (web bundle only).

## How it works

- **Lobby** (`src/components/Lobby.tsx`) — display name, public room
  directory from D1 (live counts via webhooks), join-by-code, create room,
  and an advanced "paste participant token" path that skips the backend.
- **Room** (`src/components/MeetingView.tsx`) — prebuilt `<RtkMeeting>`
  (`fill` mode, setup screen), initialized with
  `defaults: { audio: true, video: false }`. Leaving returns to the lobby.
  A **History** toggle shows saved chat from D1 (`src/components/History.tsx`);
  `HistorySync` mirrors live UI Kit chat into D1 idempotently.
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
  App.tsx             session state: lobby ⇄ meeting
  components/         Lobby, MeetingView (UI Kit wrapper)
  lib/provision.ts    Worker API client (VITE_API_URL or /api proxy)
worker/               Cloudflare Worker API + KV directory + webhooks
src-tauri/            Tauri desktop shell (no backend logic — that's the Worker)
```
