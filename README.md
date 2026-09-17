# InChat — anonymous voice rooms

Desktop voice-chat app built with **Tauri + React**, with **everything
server-side on Cloudflare**: media via **RealtimeKit** (UI Kit), API + storage
via a **Worker + KV**. Managed with **Bun**.

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
   └─ POST /api/webhooks/...     signed RealtimeKit events (live counts)
        │                    ▲
        ▼                    │ webhooks (verified RSA-SHA256)
Cloudflare KV (`ROOMS`)      Cloudflare RealtimeKit (voice media)
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

# 1. Worker storage
bunx wrangler kv namespace create ROOMS
#    paste the id into worker/wrangler.toml

# 2. Worker secrets (local dev file + production secrets)
cp worker/.dev.vars.example worker/.dev.vars   # fill in account/token/app
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID
bunx wrangler secret put CLOUDFLARE_API_TOKEN
bunx wrangler secret put CLOUDFLARE_APP_ID

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
  directory from KV (live counts via webhooks), join-by-code, create room,
  and an advanced "paste participant token" path that skips the backend.
- **Room** (`src/components/MeetingView.tsx`) — prebuilt `<RtkMeeting>`
  (`fill` mode, setup screen), initialized with
  `defaults: { audio: true, video: false }`. Leaving returns to the lobby.
- **Worker** (`worker/src/index.ts`, zero dependencies) — creates meetings,
  mints participant tokens, serves the directory from KV, and applies
  signature-verified webhook events (deduplicated via `rtk-uuid`).

## Project layout

```
src/                  React frontend (Vite)
  App.tsx             session state: lobby ⇄ meeting
  components/         Lobby, MeetingView (UI Kit wrapper)
  lib/provision.ts    Worker API client (VITE_API_URL or /api proxy)
worker/               Cloudflare Worker API + KV directory + webhooks
src-tauri/            Tauri desktop shell (no backend logic — that's the Worker)
```
