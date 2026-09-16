# aidlc-server

Internal AI-DLC operations server.

This service is the local admin/runtime hub for several AI-DLC workflows:

- Browser dashboard for rule history, fake-message testing, and direct Mattermost posting.
- Mattermost bot runtime for `@claude` questions and rule update commands.
- AST/business graph scan UI, graph viewer, and MCP endpoint for source-code questions.
- Sensitive source sanitizer for masking selected project folders before giving source code to AI agents.

## Features

- Serves a browser-authenticated dashboard on port `3003`.
- Stores rule update history in SQLite.
- Serves the graph scan UI, graph viewer, graph APIs, and graph MCP endpoint from one HTTP process.
- Serves a source sanitizer UI that uses built-in masking rules to create an AI-safe source copy.
- Receives Mattermost bot mentions in realtime via WebSocket when real Mattermost mode is enabled.
- Supports fake Mattermost mode for local testing before real admin credentials are ready.
- Replies to Mattermost through REST API or the in-memory fake chat store.
- Supports natural `@claude <question>` chat with intent classification: `rule`, `source_graph`, `mixed`, or `general`.
- Supports rule add/update/delete through Claude Code CLI (`claude -p`).
- Creates Git branches and GitHub PRs for rule updates.

## Tech stack

- Node.js + TypeScript
- `ws` for Mattermost WebSocket
- built-in `fetch` for REST APIs
- `child_process` for `claude -p`, `git`, Python graph scripts, and Docker/Joern commands
- SQLite via `better-sqlite3`
- Vue 3 + Vite for the dashboard
- Bundled static HTML graph/sanitizer tools under `graph/`

## Quick start

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
copy .env.example .env
npm install
npm run dev
```

For a production-style local run:

```powershell
npm run build
.\start-server.bat
```

Stop the background server:

```powershell
.\stop-server.bat
```

Open the main surfaces:

```text
Dashboard:        http://localhost:3003
Fake test chat:   http://localhost:3003/test-page
Graph scan:       http://localhost:3003/scan.html
Graph viewer:     http://localhost:3003/graph-viewer.html
Source sanitizer: http://localhost:3003/sensitive-scan.html
Graph health:     http://localhost:3003/api/graph/health
MCP endpoint:     http://localhost:3003/mcp
```

Logs are written to:

```text
logs/server.log
logs/error.log
```

Process wrapper logs are written to:

```text
logs/server-process.out.log
logs/server-process.err.log
```

## Web authentication

The dashboard, graph UI pages, sanitizer page, and browser APIs use a simple server-side session cookie.

Default login:

```text
admin / admin123
```

Relevant settings:

```text
AUTH_USERNAME=admin
AUTH_PASSWORD=admin123
AUTH_SESSION_TTL_HOURS=12
```

The MCP endpoint remains available without this browser login so Claude Desktop can connect through `/mcp`.

## Graph and MCP integration

The graph scan UI, graph viewer, graph APIs, and MCP endpoint run from the same `aidlc-server` process. The static UI assets and graph scripts are bundled under `graph/`. Scan outputs are written under `GRAPH_OUTPUT_ROOT_PATH`, and MCP/Claude graph queries read `GRAPH_SQLITE_DB_PATH`.

Default graph settings:

```text
GRAPH_OUTPUT_ROOT_PATH=D:\ukvn\tmp
GRAPH_SQLITE_DB_PATH=D:\ukvn\tmp\graph.sqlite
GRAPH_PYTHON_EXE=C:\Users\anhnv\AppData\Local\Programs\Python\Python312\python.exe
GRAPH_JOERN_IMAGE=ghcr.io/joernio/joern:nightly
GRAPH_MCP_ENDPOINT=/mcp
```

Claude Desktop in the same LAN can connect to:

```text
http://<server-ip>:3003/mcp
```

The old standalone graph servers are no longer required for the integrated flow, and the runtime graph UI/scripts are now bundled in `aidlc-server\graph`.

Scan UI:

```text
http://localhost:3003/scan.html
```

Graph viewer:

```text
http://localhost:3003/graph-viewer.html
```

Sensitive source sanitizer:

```text
http://localhost:3003/sensitive-scan.html
```

## Sensitive source sanitizer

The sanitizer page is intended for project admins who need to prepare source code for AI agents. It masks sensitive values directly in the selected project folders. It does not create a worktree and does not support unmasking, so run it only on a dedicated AI-safe branch or copy.

### Masking strategy

The sanitizer uses built-in masking logic instead of external Gitleaks or `redact` tools.

It scans supported text files and masks only sensitive values/literals, not sensitive-looking identifiers. Examples that should stay unchanged include Java setters/getters and route constants such as `getPasswordPolicy: "ctx/sys/.../getPasswordPolicy/"`.

Whole-file masking is applied to credential/license files:

```text
*.lic, *.license, *.pfx, *.p12, *.jks, *.keystore, *.pem, *.key, *.crt, *.cer
```

Value masking is applied to sensitive config/source values such as passwords, secrets, tokens, API keys, authorization headers, and connection strings:

```text
password, passwd, pwd, secret, token, accessToken, refreshToken, apiKey,
clientSecret, privateKey, Authorization, Bearer, Basic, jdbc:, mongodb://,
redis://, amqp://, postgres://, mysql://, sqlserver:, oracle:thin:
```

The replacement value is `__MASKED_SECRET__`.

### Page workflow

1. Open `/sensitive-scan.html` and log in.
2. Add one or more project roots, then click `Discover`, or add project paths manually.
3. Select the projects to process.
4. Click `Scan` to preview findings without changing files.
5. Click `Mask Source` to mask sensitive data directly in the selected project folders.

The `Findings` table shows masked previews without exposing raw secret values. The `Changed Files` table shows files modified by `Mask Source`.

## Dashboard and test chat

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

The dashboard also exposes:

- rule update history at `/`
- fake chat testing at `/test-page`
- direct Mattermost posting through `/api/mattermost/messages`
- runtime flags through `/api/runtime-config`

## Mattermost bot commands

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

Mattermost integration is optional. Keep `MATTERMOST_FAKE_MODE=true` for local dashboard/testing without a real Mattermost connection.

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
