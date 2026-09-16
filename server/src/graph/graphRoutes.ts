import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { config } from "../config";
import { log } from "../log";
import { GraphStore } from "./graphStore";
import { GraphMcpServer, GRAPH_MCP_SERVER_NAME, GRAPH_MCP_SERVER_VERSION } from "./mcpServer";
import { GraphScanService } from "./scanService";

export class GraphRoutes {
  private readonly scanService = new GraphScanService();

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname === config.graph.mcpEndpoint) {
      await this.handleMcp(req, res);
      return true;
    }

    if (url.pathname === "/api/graph/health") {
      sendJson(res, this.graphHealth());
      return true;
    }

    if (await this.handleScanApi(req, res, url)) {
      return true;
    }

    if (req.method === "GET" && this.isGraphStaticPath(url.pathname)) {
      this.serveGraphStatic(url.pathname, res);
      return true;
    }

    return false;
  }

  private async handleScanApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    try {
      if (req.method === "GET" && url.pathname === "/api/version") {
        sendJson(res, this.scanService.versionPayload());
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        sendJson(res, this.scanService.projectsPayload());
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/browse") {
        sendJson(res, this.scanService.browsePath(url.searchParams.get("path") ?? ""));
        return true;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const jobId = url.pathname.split("/").pop() ?? "";
        const job = this.scanService.getJob(jobId);
        if (!job) {
          sendJson(res, { error: "job-not-found" }, 404);
        } else {
          sendJson(res, job);
        }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/discover") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.projectsPayload(this.scanService.configFromPayload(body)));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.projectsPayload(this.scanService.configFromPayload(body)));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        const saved = this.scanService.saveConfig(body);
        sendJson(res, this.scanService.projectsPayload(saved));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/scan") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.startScan(body));
        return true;
      }
    } catch (err) {
      sendJson(res, { error: errorMessage(err) }, 500);
      return true;
    }

    return false;
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders({ methods: "GET, POST, DELETE, OPTIONS" }));
      res.end();
      return;
    }

    if (req.method === "GET") {
      if (String(req.headers.accept ?? "").includes("text/event-stream")) {
        this.openSse(req, res);
      } else {
        sendJson(
          res,
          {
            error: "method-not-allowed",
            message: "Use HTTP POST with a JSON-RPC MCP message body."
          },
          405
        );
      }
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, { error: "method-not-allowed" }, 405);
      return;
    }

    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      sendJson(
        res,
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${errorMessage(err)}` }
        },
        400
      );
      return;
    }

    try {
      const mcp = this.createMcpServer();
      if (Array.isArray(payload)) {
        const responses = payload.map((item) => mcp.handle(item)).filter((item) => item !== null);
        if (responses.length === 0) {
          res.writeHead(202, corsHeaders());
          res.end();
        } else {
          sendJson(res, responses);
        }
        return;
      }

      const response = mcp.handle(payload);
      if (response === null) {
        res.writeHead(202, corsHeaders());
        res.end();
      } else {
        sendJson(res, response);
      }
    } catch (err) {
      sendJson(
        res,
        {
          jsonrpc: "2.0",
          id: jsonRpcId(payload),
          error: { code: -32603, message: errorMessage(err) }
        },
        500
      );
    }
  }

  private createMcpServer() {
    return new GraphMcpServer(new GraphStore(config.graph.sqliteDbPath));
  }

  private openSse(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      ...corsHeaders(),
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(": aidlc graph stream opened\n\n");
    const interval = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch (err) {
        log.debug("MCP SSE ping failed", { error: errorMessage(err) });
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(interval);
      res.end();
    });
  }

  private graphHealth() {
    return {
      status: "ok",
      server: GRAPH_MCP_SERVER_NAME,
      version: GRAPH_MCP_SERVER_VERSION,
      endpoint: config.graph.mcpEndpoint,
      transport: "streamable-http",
      graphRoot: config.graph.rootPath,
      outputRoot: config.graph.outputRootPath,
      businessGraphDir: config.graph.businessGraphDir,
      db: config.graph.sqliteDbPath,
      dbExists: existsSync(config.graph.sqliteDbPath)
    };
  }

  private isGraphStaticPath(pathname: string) {
    return (
      pathname === "/scan.html" ||
      pathname === "/sensitive-scan.html" ||
      pathname === "/graph-viewer.html" ||
      pathname === "/scan-config.json" ||
      pathname === "/scan-url.txt" ||
      pathname === "/viewer-url.txt" ||
      pathname.startsWith("/business-graph/") ||
      pathname.startsWith("/graph/")
    );
  }

  private serveGraphStatic(pathname: string, res: ServerResponse) {
    const requestPath = pathname.startsWith("/graph/") ? pathname.slice("/graph".length) || "/scan.html" : pathname;
    const target = this.graphStaticTarget(requestPath);
    this.serveStaticFrom(target.basePath, target.requestPath, res);
  }

  private graphStaticTarget(requestPath: string) {
    if (requestPath === "/scan-config.json") {
      return { basePath: config.graph.outputRootPath, requestPath };
    }

    if (requestPath.startsWith("/business-graph/")) {
      return {
        basePath: config.graph.businessGraphDir,
        requestPath: requestPath.slice("/business-graph".length)
      };
    }

    return { basePath: config.graph.rootPath, requestPath };
  }

  private serveStaticFrom(basePath: string, requestPath: string, res: ServerResponse) {
    const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = resolve(join(basePath, safePath));
    const root = resolve(basePath);

    if (filePath !== root && !filePath.startsWith(`${root}\\`) && !filePath.startsWith(`${root}/`)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      sendJson(res, { error: "not-found" }, 404);
      return;
    }

    res.writeHead(200, { "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  }
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, body: unknown, statusCode = 200) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(body, null, 2));
}

function corsHeaders(options: { methods?: string } = {}) {
  return {
    vary: "Origin",
    "access-control-allow-methods": options.methods ?? "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id"
  };
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
    case ".ndjson":
      return "application/x-ndjson; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function jsonRpcId(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
