import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { config } from "../config";
import type { MattermostMessage } from "../domain/types";
import { RuleUpdateHistoryStore } from "../db/ruleUpdateHistoryStore";
import { CommandHandler } from "../commands/handler";
import { log } from "../log";
import { fakeChatStore } from "../mattermost/fakeChatStore";
import { MattermostClient } from "../mattermost/client";

export function startHttpServer(
  history: RuleUpdateHistoryStore,
  commandHandler: CommandHandler,
  mattermost: MattermostClient
) {
  const server = createServer((req, res) => {
    void route(req, res, history, commandHandler, mattermost);
  });

  server.listen(config.serverPort, () => {
    log.info("HTTP server started", {
      port: config.serverPort,
      dashboard: `http://localhost:${config.serverPort}`
    });
  });

  return server;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  history: RuleUpdateHistoryStore,
  commandHandler: CommandHandler,
  mattermost: MattermostClient
) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, { status: "ok", time: new Date().toISOString() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runtime-config") {
      sendJson(res, {
        mattermostFakeMode: config.mattermost.fakeMode,
        allowedChannelIds: Array.from(config.mattermost.allowedChannelIds),
        ruleUpdateDryRun: config.ruleUpdateDryRun,
        claudeFakeMode: config.claude.fakeMode
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/rule-updates") {
      sendJson(res, {
        items: history.list({
          status: url.searchParams.get("status") || undefined,
          ruleId: url.searchParams.get("ruleId") || undefined,
          user: url.searchParams.get("user") || undefined,
          q: url.searchParams.get("q") || undefined
        })
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/test-chat/messages") {
      sendJson(res, { items: fakeChatStore.list() });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/test-chat/messages") {
      fakeChatStore.clear();
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/test-chat/messages") {
      const body = await readJsonBody(req);
      const message = toFakeMessage(body);
      fakeChatStore.addUser(message);
      setImmediate(() => {
        void commandHandler.handle(message).catch((err) => {
          log.error("Test chat message handling failed", { error: err instanceof Error ? err.message : String(err) });
        });
      });
      sendJson(res, { accepted: true, message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mattermost/messages") {
      const body = await readJsonBody(req);
      const request = toMattermostPostRequest(body);
      const results = [];

      for (const channelId of request.channelIds) {
        if (config.mattermost.allowedChannelIds.size > 0 && !config.mattermost.allowedChannelIds.has(channelId)) {
          sendJson(res, { error: `channel_not_allowed: ${channelId}` }, 403);
          return;
        }

        const result = await mattermost.postPlainMessage({ channelId, message: request.message });
        results.push({ channelId, postId: result.id ?? null });
      }

      sendJson(res, { ok: true, results });
      return;
    }

    const detailMatch = /^\/api\/rule-updates\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && detailMatch) {
      const item = history.get(Number(detailMatch[1]));
      if (!item) {
        sendJson(res, { error: "not_found" }, 404);
        return;
      }
      sendJson(res, { item });
      return;
    }

    if (req.method === "POST" && url.pathname === "/dev/fake-message") {
      const body = await readJsonBody(req);
      const message = toFakeMessage(body);
      fakeChatStore.addUser(message);
      setImmediate(() => {
        void commandHandler.handle(message).catch((err) => {
          log.error("Fake message handling failed", { error: err instanceof Error ? err.message : String(err) });
        });
      });
      sendJson(res, { accepted: true, message });
      return;
    }

    if (req.method === "GET") {
      serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, { error: "method_not_allowed" }, 405);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function toFakeMessage(body: unknown): MattermostMessage {
  const data = isRecord(body) ? body : {};
  return {
    postId: String(data.postId ?? `fake-post-${Date.now()}`),
    channelId: String(data.channelId ?? defaultFakeChannelId()),
    userId: String(data.userId ?? "fake-admin-user-id"),
    username: data.username ? String(data.username) : "FakeUser",
    message: String(data.message ?? ""),
    rootId: data.rootId ? String(data.rootId) : undefined,
    createdAt: new Date().toISOString()
  };
}

function defaultFakeChannelId() {
  return Array.from(config.mattermost.allowedChannelIds)[0] ?? "fake-channel-id";
}

function toMattermostPostRequest(body: unknown) {
  const data = isRecord(body) ? body : {};
  const message = String(data.message ?? "").trim();
  if (!message) {
    throw new Error("message is required");
  }

  const rawChannelIds = Array.isArray(data.channelIds)
    ? data.channelIds
    : data.channelId === "__all__"
      ? Array.from(config.mattermost.allowedChannelIds)
      : [data.channelId];

  const channelIds = rawChannelIds
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    throw new Error("channelId or channelIds is required");
  }

  return {
    message,
    channelIds: Array.from(new Set(channelIds))
  };
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function serveStatic(pathname: string, res: ServerResponse) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(config.dashboardDistDir, safePath);

  if (!filePath.startsWith(config.dashboardDistDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    const fallback = join(config.dashboardDistDir, "index.html");
    if (existsSync(fallback)) {
      streamFile(fallback, res);
      return;
    }
    sendText(res, "Dashboard has not been built. Run npm run build:dashboard.", 404);
    return;
  }

  streamFile(filePath, res);
}

function streamFile(path: string, res: ServerResponse) {
  res.writeHead(200, { "content-type": contentType(path) });
  createReadStream(path).pipe(res);
}

function contentType(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function sendJson(res: ServerResponse, body: unknown, statusCode = 200) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res: ServerResponse, body: string, statusCode = 200) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
