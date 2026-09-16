# Hướng Dẫn Cài Đặt Và Chạy aidlc-server

Tài liệu này hướng dẫn chuẩn bị một máy mới để chạy `aidlc-server`, bao gồm cả phần cài đặt Docker và Joern cho chức năng Graph Scan.

## 1. Tổng Quan Project

`aidlc-server` là server Node.js/TypeScript gồm các phần sau:

- Dashboard web chạy trên port `3003`.
- Runtime cho Mattermost bot.
- Luồng cập nhật rule có thể gọi Claude Code CLI, Git và GitHub PR API.
- Graph Scan UI và Graph Viewer.
- MCP endpoint đọc graph tại `/mcp`.
- Giao diện Sensitive Source Sanitizer.

Tech stack chính:

- Node.js 22.x và npm.
- TypeScript.
- Vue 3 và Vite cho dashboard.
- SQLite local qua `better-sqlite3`.
- Python 3.12 cho script build/import business graph.
- Docker + Joern image cho CPG scan.

## 2. Folder Cần Có

Khuyến nghị giữ layout giống máy hiện tại:

```text
D:\ukvn\src\ai.dlc\aidlc-server
D:\ukvn\tmp
D:\ukvn\src\ai.dlc\uk_aidlc
```

Ý nghĩa:

- `aidlc-server`: project Node.js này.
- `aidlc-server\graph`: chứa `scan.html`, `graph-viewer.html` và script Python đã được bundle cùng server.
- `D:\ukvn\tmp`: chứa output scan như CPG, log, `business-graph` và `graph.sqlite`.
- `uk_aidlc`: repo rule/source dùng cho Mattermost rule bot và rule update PR flow.

File graph quan trọng:

```text
D:\ukvn\tmp\graph.sqlite
```

Nếu chỉ cần query graph/MCP từ dữ liệu có sẵn, cần copy `graph.sqlite`. Static UI/script đã nằm trong `aidlc-server\graph`. Nếu muốn scan lại source bằng Joern, cần cài Docker và pull Joern image.

## 3. Cài Đặt Công Cụ Bắt Buộc

### 3.1 Node.js 22.x

Cài Node.js 22.x từ trang Node.js hoặc package manager nội bộ.

Kiểm tra:

```powershell
node -v
npm -v
```

Máy hiện tại đang dùng:

```text
node v22.23.2
npm 10.9.8
```

### 3.2 Git

Cài Git for Windows.

Kiểm tra:

```powershell
git --version
```

Git là bắt buộc khi:

- Lấy source từ repository.
- Chạy rule update ở real mode.
- Graph Scan đọc metadata branch/commit của source project.

### 3.3 Python 3.12

Cài Python 3.12.

Kiểm tra:

```powershell
python --version
```

Nếu `python` không có trong `PATH`, vẫn có thể cấu hình đường dẫn tuyệt đối trong `.env`:

```env
GRAPH_PYTHON_EXE=C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe
```

Project hiện chưa có `requirements.txt`; các script graph đang dùng Python standard library.

### 3.4 Claude Code CLI

Cần cài nếu chạy với:

```env
CLAUDE_FAKE_MODE=false
```

Kiểm tra lệnh Claude:

```powershell
claude --version
```

Nếu lệnh `claude` không có trong `PATH`, cấu hình đường dẫn tuyệt đối:

```env
CLAUDE_COMMAND=C:\Users\<user>\AppData\Roaming\npm\claude.cmd
```

Để test local không cần Claude thật, có thể dùng:

```env
CLAUDE_FAKE_MODE=true
```

### 3.5 Visual Studio Build Tools Khi Cần

Dependency `better-sqlite3` là native module. Thông thường `npm ci` sẽ tải prebuilt binary. Nếu install bị lỗi build native module, cài thêm:

- Visual Studio Build Tools.
- Workload `Desktop development with C++`.
- Windows SDK.

Sau đó chạy lại:

```powershell
npm ci
```

## 4. Cài Đặt Docker Và Joern

### 4.1 Cài Docker Desktop Trên Windows

1. Bật virtualization trong BIOS/UEFI nếu chưa bật.
2. Cài WSL2 nếu Docker Desktop yêu cầu.
3. Tải và cài Docker Desktop.
4. Mở Docker Desktop và đợi đến khi Docker Engine đang chạy.

Kiểm tra:

```powershell
docker version
docker run --rm hello-world
```

Nếu lệnh Docker báo lỗi permission/config, mở Docker Desktop trước rồi chạy lại trong terminal mới.

### 4.2 Pull Joern Docker Image

Project không cần cài Joern native trên Windows. Graph Scan gọi Joern qua Docker image:

```text
ghcr.io/joernio/joern:nightly
```

Pull image:

```powershell
docker pull ghcr.io/joernio/joern:nightly
```

Kiểm tra image đã có:

```powershell
docker images ghcr.io/joernio/joern
```

Kiểm tra Joern trong container:

```powershell
docker run --rm ghcr.io/joernio/joern:nightly joern --version
```

Lưu ý:

- Image Joern khá lớn, có thể hơn 6 GB.
- Khi Graph Scan bật tùy chọn `pullJoernImage`, server sẽ chạy `docker pull ghcr.io/joernio/joern:nightly`.
- Khi Graph Scan bật tùy chọn `scanJoern`, server sẽ chạy `docker run` để tạo CPG cho Java và UI JS/TS.

## 5. Cấu Hình `.env`

Từ root project:

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
copy .env.example .env
```

Sửa `.env` theo máy mới.

### 5.1 Cấu Hình Local Test An Toàn

Dùng fake mode trước để xác nhận server chạy:

```env
SERVER_PORT=3003

AUTH_USERNAME=admin
AUTH_PASSWORD=admin123
AUTH_SESSION_TTL_HOURS=12

GRAPH_OUTPUT_ROOT_PATH=D:\ukvn\tmp
GRAPH_SQLITE_DB_PATH=D:\ukvn\tmp\graph.sqlite
GRAPH_PYTHON_EXE=C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe
GRAPH_JOERN_IMAGE=ghcr.io/joernio/joern:nightly
GRAPH_MCP_ENDPOINT=/mcp

MATTERMOST_FAKE_MODE=true
MATTERMOST_BASE_URL=https://mattermost.example.jp
MATTERMOST_BOT_TOKEN=
MATTERMOST_BOT_USER_ID=bot-user-id
MATTERMOST_BOT_USERNAME=claude
MATTERMOST_ALLOWED_CHANNEL_IDS=fake-channel-id
MATTERMOST_INCOMING_WEBHOOK_URL=

RULE_UPDATE_AUTHORIZED_USERNAMES=thuytt

AIDLC_REPO_PATH=D:\ukvn\src\ai.dlc\uk_aidlc
GITHUB_OWNER=your-org
GITHUB_REPO=aidlc-session
GITHUB_TOKEN=
GITHUB_BASE_BRANCH=main

RULE_UPDATE_DRY_RUN=true
CLAUDE_FAKE_MODE=true
CLAUDE_COMMAND=claude
CLAUDE_TIMEOUT_MS=300000
CLAUDE_EXTRA_ARGS=
```

### 5.2 Cấu Hình Real Mode

Chỉ bật real mode sau khi local fake mode chạy ổn:

```env
MATTERMOST_FAKE_MODE=false
MATTERMOST_BASE_URL=https://<mattermost-host>
MATTERMOST_BOT_TOKEN=<bot-token>
MATTERMOST_BOT_USER_ID=<bot-user-id>
MATTERMOST_ALLOWED_CHANNEL_IDS=<channel-id-1>,<channel-id-2>

RULE_UPDATE_DRY_RUN=false
GITHUB_OWNER=<github-owner>
GITHUB_REPO=<github-repo>
GITHUB_TOKEN=<github-token>
GITHUB_BASE_BRANCH=main

CLAUDE_FAKE_MODE=false
CLAUDE_COMMAND=C:\Users\<user>\AppData\Roaming\npm\claude.cmd
CLAUDE_TIMEOUT_MS=900000
CLAUDE_EXTRA_ARGS=--permission-mode,bypassPermissions
```

Lưu ý bảo mật:

- Không commit `.env`.
- Không chia sẻ `MATTERMOST_BOT_TOKEN` và `GITHUB_TOKEN`.
- Khi `RULE_UPDATE_DRY_RUN=false`, `AIDLC_REPO_PATH` phải là repo Git sạch, không có uncommitted changes.

## 6. Cài Dependency Và Build

Từ root project:

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
npm ci
npm run build
```

Nếu máy mới không có `package-lock.json`, dùng:

```powershell
npm install
npm run build
```

Lệnh build sẽ chạy:

- `vite build --config dashboard/vite.config.ts`
- `tsc -p server/tsconfig.json`

Output:

```text
dist\dashboard
dist\server
```

## 7. Chạy Project

### 7.1 Chạy Dev Mode

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
npm run dev
```

Lệnh này build dashboard trước, sau đó chạy server bằng `tsx watch`.

### 7.2 Chạy Production-Style Local

```powershell
cd D:\ukvn\src\ai.dlc\aidlc-server
npm run build
.\start-server.bat
```

Dừng server:

```powershell
.\stop-server.bat
```

Script `start-server.bat` sẽ:

- Chạy `node dist/server/main.js`.
- Ghi PID vào `aidlc-server.pid`.
- Ghi log process vào `logs\server-process.out.log` và `logs\server-process.err.log`.

## 8. Kiểm Tra Sau Khi Chạy

Mở các URL:

```text
Dashboard:        http://localhost:3003
Fake test chat:   http://localhost:3003/test-page
Graph scan:       http://localhost:3003/scan.html
Graph viewer:     http://localhost:3003/graph-viewer.html
Source sanitizer: http://localhost:3003/sensitive-scan.html
Graph health:     http://localhost:3003/api/graph/health
MCP endpoint:     http://localhost:3003/mcp
Health:           http://localhost:3003/health
```

Kiểm tra bằng PowerShell:

```powershell
Invoke-RestMethod http://localhost:3003/health
Invoke-RestMethod http://localhost:3003/api/auth/status
```

Test MCP `tools/list`:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3003/mcp" `
  -ContentType "application/json" `
  -Body $body
```

Log app:

```text
logs\server.log
logs\error.log
logs\server-process.out.log
logs\server-process.err.log
```

## 9. Chạy Graph Scan Với Docker/Joern

Mở:

```text
http://localhost:3003/scan.html
```

Quy trình:

1. Đăng nhập dashboard.
2. Kiểm tra `GRAPH_OUTPUT_ROOT_PATH`, `GRAPH_SQLITE_DB_PATH` và `GRAPH_PYTHON_EXE`.
3. Thêm project root hoặc browse folder source.
4. Chọn project cần scan.
5. Nếu muốn tạo CPG, bật `scanJoern`.
6. Nếu muốn pull image mới, bật `pullJoernImage`.
7. Chạy scan.

Khi bật Joern, server sẽ chạy các lệnh Docker tương đương:

```powershell
docker pull ghcr.io/joernio/joern:nightly
docker run --rm -v <source>:/src:ro -v <graph-output-root>:/graph ghcr.io/joernio/joern:nightly ...
```

Output quan trọng:

```text
D:\ukvn\tmp\cpg
D:\ukvn\tmp\business-graph\nodes.ndjson
D:\ukvn\tmp\business-graph\edges.ndjson
D:\ukvn\tmp\graph.sqlite
D:\ukvn\tmp\logs
```

Nếu chỉ cần rebuild business graph/SQLite mà không scan Joern, tắt `scanJoern`. Khi đó Docker không được sử dụng.

## 10. Test Mattermost Fake Mode

Khi `.env` có:

```env
MATTERMOST_FAKE_MODE=true
CLAUDE_FAKE_MODE=true
RULE_UPDATE_DRY_RUN=true
```

Chạy server rồi test:

```powershell
npm run fake:ask
npm run fake:add
npm run fake:update
npm run fake:delete
```

Hoặc mở:

```text
http://localhost:3003/test-page
```

## 11. Lỗi Thường Gặp

### `AIDLC_REPO_PATH does not exist`

Sửa `.env`:

```env
AIDLC_REPO_PATH=D:\ukvn\src\ai.dlc\uk_aidlc
```

Đảm bảo folder tồn tại và là Git repo.

### `Bundled graph runtime path does not exist`

Đảm bảo thư mục bundle đi cùng server tồn tại:

```text
D:\ukvn\src\ai.dlc\aidlc-server\graph
```

Thư mục này phải có `scan.html`, `graph-viewer.html`, `sensitive-scan.html` và `scripts`.

### `Dashboard has not been built`

Chạy:

```powershell
npm run build
```

### Docker/Joern Không Chạy

Kiểm tra:

```powershell
docker version
docker images ghcr.io/joernio/joern
docker run --rm ghcr.io/joernio/joern:nightly joern --version
```

Nếu Docker command lỗi, mở Docker Desktop và đợi Docker Engine start xong.

### `better-sqlite3` Install Lỗi

Thử các bước:

```powershell
npm cache verify
npm ci
```

Nếu vẫn lỗi native build, cài Visual Studio Build Tools với C++ workload rồi chạy lại.

### Mattermost Real Mode Không Kết Nối

Kiểm tra `.env`:

```env
MATTERMOST_FAKE_MODE=false
MATTERMOST_BASE_URL=https://<mattermost-host>
MATTERMOST_BOT_TOKEN=<bot-token>
MATTERMOST_BOT_USER_ID=<bot-user-id>
MATTERMOST_ALLOWED_CHANNEL_IDS=<channel-id-1>,<channel-id-2>
```

Server sẽ kết nối WebSocket:

```text
wss://<mattermost-host>/api/v4/websocket
```

Và post reply qua:

```text
https://<mattermost-host>/api/v4/posts
```
