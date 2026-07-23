import WebSocket from "ws";
import { config } from "../config";
import type { MattermostMessage } from "../domain/types";
import { log } from "../log";

type MessageHandler = (message: MattermostMessage) => void | Promise<void>;

export class MattermostWebSocketListener {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private seq = 1;

  constructor(private readonly onMessage: MessageHandler) {}

  start() {
    if (config.mattermost.fakeMode) {
      log.info("Mattermost fake mode enabled; WebSocket connection skipped");
      return;
    }
    this.connect();
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect() {
    const base = config.mattermost.baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${base}/api/v4/websocket`;
    log.info("Connecting to Mattermost WebSocket", { url });

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      log.info("Mattermost WebSocket connected");
      this.authenticate();
    });

    this.ws.on("message", (data) => {
      void this.handleRawMessage(data.toString());
    });

    this.ws.on("close", () => {
      log.warn("Mattermost WebSocket closed; reconnecting soon");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error("Mattermost WebSocket error", { error: err.message });
    });
  }

  private authenticate() {
    this.ws?.send(
      JSON.stringify({
        seq: this.seq++,
        action: "authentication_challenge",
        data: {
          token: config.mattermost.botToken
        }
      })
    );
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private async handleRawMessage(raw: string) {
    const event = safeJsonParse(raw) as { event?: string; data?: Record<string, unknown> } | null;
    if (!event || event.event !== "posted") return;

    const postRaw = event.data?.post;
    if (typeof postRaw !== "string") return;
    const post = safeJsonParse(postRaw) as Record<string, unknown> | null;
    if (!post) return;

    const userId = String(post.user_id ?? "");
    const channelId = String(post.channel_id ?? "");
    if (!userId || userId === config.mattermost.botUserId) return;
    if (config.mattermost.allowedChannelIds.size > 0 && !config.mattermost.allowedChannelIds.has(channelId)) {
      return;
    }

    await this.onMessage({
      postId: String(post.id ?? ""),
      channelId,
      userId,
      username: undefined,
      message: String(post.message ?? ""),
      rootId: typeof post.root_id === "string" && post.root_id ? post.root_id : String(post.id ?? ""),
      createdAt: new Date(Number(post.create_at ?? Date.now())).toISOString()
    });
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
