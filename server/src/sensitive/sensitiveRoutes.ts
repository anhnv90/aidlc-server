import type { IncomingMessage, ServerResponse } from "node:http";
import { SensitiveScanService } from "./sensitiveScanService";

export class SensitiveRoutes {
  private readonly scanService = new SensitiveScanService();

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/sensitive")) return false;

    try {
      if (req.method === "GET" && url.pathname === "/api/sensitive/health") {
        sendJson(res, { status: "ok", service: "sensitive-scan" });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/sensitive/defaults") {
        sendJson(res, this.scanService.defaultPayload());
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/sensitive/browse") {
        sendJson(res, this.scanService.browsePath(url.searchParams.get("path") ?? ""));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/sensitive/discover") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.discoverProjects(body));
        return true;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/sensitive/jobs/")) {
        const jobId = url.pathname.split("/").pop() ?? "";
        const job = this.scanService.getJob(jobId);
        if (!job) {
          sendJson(res, { error: "job-not-found" }, 404);
        } else {
          sendJson(res, job);
        }
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/sensitive/scan") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.startScan(body));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/sensitive/mask") {
        const body = await readJsonBody(req);
        sendJson(res, this.scanService.startMask(body));
        return true;
      }

      sendJson(res, { error: "not-found" }, 404);
      return true;
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      return true;
    }
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
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}
