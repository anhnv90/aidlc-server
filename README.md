# aidlc-server

Internal AI-DLC Mattermost bot server.

## Features

- Receives Mattermost bot mentions in realtime via WebSocket.
- Replies to Mattermost through REST API.
- Supports natural `@claude <question>` chat: Claude classifies the question, searches the AI-DLC repo for rule-related questions, and answers directly for non-rule questions.
- Supports rule add/update/delete through Claude Code CLI (`claude -p`).
- Creates Git branches and GitHub PRs for rule updates.
- Stores rule update history in SQLite.
- Serves the AST/business graph MCP endpoint for Claude Desktop on the same HTTP server.
- Serves the graph scan UI and graph viewer on the same HTTP server.
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
http://localhost:3003/scan.html
http://localhost:3003/graph-viewer.html
http://localhost:3003/api/graph/health
```

Logs are written to:

```text
logs/server.log
logs/error.log
```

## Graph and MCP integration

The Mattermost bot, graph scan UI, graph viewer, and MCP endpoint now run from the same `aidlc-server` process.

Default graph settings:

```text
AUTH_USERNAME=admin
AUTH_PASSWORD=admin123
AUTH_SESSION_TTL_HOURS=12
GRAPH_ROOT_PATH=D:\ukvn\src\ai.dlc\hr.ast-graph
GRAPH_SQLITE_DB_PATH=D:\ukvn\src\ai.dlc\hr.ast-graph\business-graph\graph.sqlite
GRAPH_PYTHON_EXE=C:\Users\anhnv\AppData\Local\Programs\Python\Python312\python.exe
GRAPH_JOERN_IMAGE=ghcr.io/joernio/joern:nightly
GRAPH_MCP_ENDPOINT=/mcp
```

The web UI uses a simple server-side session cookie. The default login is:

```text
admin / admin123
```

The MCP endpoint remains available without this browser login so Claude Desktop can connect through `/mcp`.

Claude Desktop in the same LAN can connect to:

```text
http://<server-ip>:3003/mcp
```

The old standalone graph servers are no longer required for the integrated flow:

```text
D:\ukvn\src\ai.dlc\hr.ast-graph\start-scan-server.bat
D:\ukvn\src\ai.dlc\hr.ast-graph\mcp-server\start-http-mcp-server.bat
```

Scan UI:

```text
http://localhost:3003/scan.html
```

Graph viewer:

```text
http://localhost:3003/graph-viewer.html
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

### Ask Claude / search rules and source graph

Allowed for everyone in configured channels.

```text
@claude rule browser test da co chua?

or

@claude hello, please explain what this bot can do

or

@claude rule ask rule browser test da co chua?

or

@claude màn hình JAM001 gọi endpoint nào?

or

@claude RemandCommandHandler xử lý nghiệp vụ gì?

or

@claude theo rule AIDLC thì flow JAM001 đã đủ Done chưa?
```

The bot classifies each natural-language question as `rule`, `source_graph`, `mixed`, or `general`.

- `rule`: Claude inspects the AI-DLC rule repository.
- `source_graph`: the server reads the SQLite business/source graph and passes graph evidence to Claude.
- `mixed`: Claude combines rule repository evidence with graph evidence.
- `general`: Claude answers without reading rules or graph.

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
