# Deploy aidlc-server on Ubuntu

This guide deploys one integrated server that provides:

- Mattermost chatbot endpoint/listener
- Web dashboard with login
- Graph Scan UI
- Graph Viewer
- HTTP MCP endpoint for Claude Desktop

Default service port:

```text
3003
```

## 1. Prepare Ubuntu

Recommended OS: Ubuntu 22.04 or 24.04.

Install base packages:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 python3-venv python3-pip
```

Install Node.js 22.x:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Optional, only needed if Graph Scan will run Joern CPG scan:

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Log out and log in again after adding the user to the `docker` group.

## 2. Create folders

Recommended layout:

```bash
sudo mkdir -p /opt/aidlc
sudo chown -R $USER:$USER /opt/aidlc
```

Example target paths:

```text
/opt/aidlc/aidlc-server
/opt/aidlc/hr.ast-graph
/opt/aidlc/aidlc-session
```

`aidlc-server` is the Node.js server.

`hr.ast-graph` contains:

- `scan.html`
- `graph-viewer.html`
- `scripts/`
- `business-graph/graph.sqlite`
- `business-graph/*.ndjson`

`aidlc-session` is the AI-DLC rules/source repository used by the Mattermost rule bot.

## 3. Copy or clone source

Option A, clone from Git:

```bash
cd /opt/aidlc
git clone <your-aidlc-server-repo-url> aidlc-server
git clone <your-aidlc-session-repo-url> aidlc-session
```

Option B, copy from Windows/server share:

```bash
rsync -av /path/from/aidlc-server/ /opt/aidlc/aidlc-server/
rsync -av /path/from/hr.ast-graph/ /opt/aidlc/hr.ast-graph/
rsync -av /path/from/aidlc-session/ /opt/aidlc/aidlc-session/
```

Do not skip `hr.ast-graph/business-graph/graph.sqlite`; MCP reads this file.

## 4. Install dependencies and build

```bash
cd /opt/aidlc/aidlc-server
npm ci
npm run build
```

If `better-sqlite3` fails to install, check that `build-essential` and Python are installed.

## 5. Configure environment

Create `.env`:

```bash
cd /opt/aidlc/aidlc-server
cp .env.example .env
nano .env
```

Use Linux paths, not Windows paths:

```env
SERVER_PORT=3003

AUTH_USERNAME=admin
AUTH_PASSWORD=admin123
AUTH_SESSION_TTL_HOURS=12

GRAPH_ROOT_PATH=/opt/aidlc/hr.ast-graph
GRAPH_SQLITE_DB_PATH=/opt/aidlc/hr.ast-graph/business-graph/graph.sqlite
GRAPH_PYTHON_EXE=/usr/bin/python3
GRAPH_JOERN_IMAGE=ghcr.io/joernio/joern:nightly
GRAPH_MCP_ENDPOINT=/mcp

MATTERMOST_FAKE_MODE=false
MATTERMOST_BASE_URL=https://<your-mattermost-host>
MATTERMOST_BOT_TOKEN=<bot-token>
MATTERMOST_BOT_USER_ID=<bot-user-id>
MATTERMOST_BOT_USERNAME=claude
MATTERMOST_ALLOWED_CHANNEL_IDS=<channel-id-1>,<channel-id-2>
MATTERMOST_INCOMING_WEBHOOK_URL=

RULE_UPDATE_AUTHORIZED_USERNAMES=<authorized-usernames>

AIDLC_REPO_PATH=/opt/aidlc/aidlc-session
GITHUB_OWNER=<your-org>
GITHUB_REPO=<your-repo>
GITHUB_TOKEN=<github-token>
GITHUB_BASE_BRANCH=main

RULE_UPDATE_DRY_RUN=true
CLAUDE_FAKE_MODE=false
CLAUDE_COMMAND=claude
CLAUDE_TIMEOUT_MS=300000
CLAUDE_EXTRA_ARGS=
```

For first deployment, keep:

```env
RULE_UPDATE_DRY_RUN=true
```

Switch to `false` only after GitHub token, branch permissions, and PR flow are verified.

## 6. Verify manually

Start once from shell:

```bash
cd /opt/aidlc/aidlc-server
npm start
```

Open another terminal:

```bash
curl http://127.0.0.1:3003/health
curl http://127.0.0.1:3003/api/auth/status
curl http://127.0.0.1:3003/api/graph/health
```

Test MCP tools/list:

```bash
curl -s http://127.0.0.1:3003/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Stop the foreground server with `Ctrl+C`.

## 7. Create systemd service

Create service file:

```bash
sudo nano /etc/systemd/system/aidlc-server.service
```

Content:

```ini
[Unit]
Description=AIDLC integrated Mattermost and Graph MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<ubuntu-user>
WorkingDirectory=/opt/aidlc/aidlc-server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/aidlc/aidlc-server/dist/server/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `<ubuntu-user>` with the real Linux user.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aidlc-server
sudo systemctl status aidlc-server
```

View logs:

```bash
journalctl -u aidlc-server -f
```

The application also writes logs under:

```text
/opt/aidlc/aidlc-server/logs/
```

## 8. Open firewall

For internal LAN access:

```bash
sudo ufw allow 3003/tcp
sudo ufw status
```

URLs:

```text
http://<ubuntu-server-ip>:3003/
http://<ubuntu-server-ip>:3003/scan.html
http://<ubuntu-server-ip>:3003/graph-viewer.html
http://<ubuntu-server-ip>:3003/mcp
```

## 9. Configure Claude Desktop

Use the Ubuntu server IP:

```json
{
  "mcpServers": {
    "aidlc-graph": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "mcp-remote",
        "http://<ubuntu-server-ip>:3003/mcp",
        "--allow-http",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

Restart Claude Desktop after editing config.

## 10. Graph scan notes

The scan UI is available at:

```text
http://<ubuntu-server-ip>:3003/scan.html
```

Important:

- Project roots must be Linux paths.
- Windows paths such as `D:\src.uk\...` will not exist on Ubuntu.
- Copy the source projects to Ubuntu or mount them with SMB/NFS.
- If Joern scan is enabled, Docker must be installed and the service user must be allowed to run Docker.
- If Joern scan is disabled, Python scripts can still build/import the business graph from selected source projects.

Example Linux project roots:

```text
/opt/aidlc/source/nts.uk
/opt/aidlc/source/nts.uk.sub
```

## 11. Security notes

The browser UI uses login:

```text
admin / admin123
```

Change this in `.env` before production use.

The MCP endpoint `/mcp` is currently left open so Claude Desktop can connect without browser login. Keep port `3003` on the internal LAN only. If the server is exposed outside the company network, add one of these before production:

- VPN-only access
- reverse proxy with authentication
- MCP token check in `aidlc-server`
- IP allowlist

## 12. Update deployment

After code changes:

```bash
cd /opt/aidlc/aidlc-server
git pull
npm ci
npm run build
sudo systemctl restart aidlc-server
sudo systemctl status aidlc-server
```

After graph data changes:

```bash
rsync -av /path/from/hr.ast-graph/business-graph/ /opt/aidlc/hr.ast-graph/business-graph/
sudo systemctl restart aidlc-server
```

Restart is not always required for graph data because SQLite is opened per request, but restarting is a simple safe check after deployment.
