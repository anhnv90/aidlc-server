# aidlc-server

Internal AI-DLC Mattermost bot server.

## Features

- Receives Mattermost bot mentions in realtime via WebSocket.
- Replies to Mattermost through REST API.
- Supports natural `@claude <question>` chat: Claude classifies the question, searches the AI-DLC repo for rule-related questions, and answers directly for non-rule questions.
- Supports rule add/update/delete through Claude Code CLI (`claude -p`).
- Creates Git branches and GitHub PRs for rule updates.
- Stores rule update history in SQLite.
- Serves a dashboard on port `3003` with rule history and direct Mattermost posting.
- Includes fake Mattermost mode for local testing before real admin credentials are ready.

## Tech stack

- Node.js + TypeScript
- `ws` for Mattermost WebSocket
- built-in `fetch` for REST APIs
- `child_process` for `claude -p` and `git`
- SQLite via `better-sqlite3`
- Vue 3 + Vite for the read-only dashboard

## Quick start

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
copy .env.example .env
npm install
npm run dev
```

Open:

```text
http://localhost:3003
http://localhost:3003/test-page
```

Logs are written to:

```text
logs/server.log
logs/error.log
```

## Fake Mattermost tests

With default `.env` values, the server runs in fake mode.

In another terminal:

```powershell
npm run fake:ask
npm run fake:add
npm run fake:update
npm run fake:delete
```

You can also post your own fake message:

```powershell
$body = @{
  userId = "fake-admin-user-id"
  username = "ThuyTT"
  channelId = "fake-channel-id"
  message = "@claude browser based done rule da co chua?"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "http://localhost:3003/dev/fake-message" -ContentType "application/json" -Body $body
```

## Commands

### Ask Claude / search rules

Allowed for everyone in configured channels.

```text
@claude rule browser test da co chua?

or

@claude hello, please explain what this bot can do

or

@claude rule ask rule browser test da co chua?
```

### Add rule

Allowed only for `RULE_UPDATE_AUTHORIZED_USERNAMES`.

```text
@claude rule add
rule_id: DOD-UI-01
target: aidlc-rules/.aidlc-rule-details/construction/build-and-test.md
title: Browser-based user journey is required before Done
content:
  A user-facing screen is not Done until browser-based user journey testing passes.
acceptance:
  - Add browser evidence requirement.
  - Create PR only; do not merge automatically.
```

### Update rule

```text
@claude rule update
rule_id: DOD-UI-01
content:
  A user-facing screen is not considered Done until browser-based user journey testing passes.
```

### Delete rule

Deletes directly in the generated PR. The authorized updater owns this responsibility.

```text
@claude rule delete
rule_id: DOD-UI-01
```

## Real Mattermost mode

Update `.env`:

```text
MATTERMOST_FAKE_MODE=false
MATTERMOST_BASE_URL=https://<mattermost>
MATTERMOST_BOT_TOKEN=<bot-token>
MATTERMOST_BOT_USER_ID=<bot-user-id>
MATTERMOST_BOT_USERNAME=claude
MATTERMOST_ALLOWED_CHANNEL_IDS=<channel-id-1>,<channel-id-2>
MATTERMOST_INCOMING_WEBHOOK_URL=
RULE_UPDATE_AUTHORIZED_USERNAMES=<authorized-username>
```

The server connects outbound to:

```text
wss://<mattermost>/api/v4/websocket
```

and replies through:

```text
https://<mattermost>/api/v4/posts
```
