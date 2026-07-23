import { config } from "../config";
import { log } from "../log";
import { formatAttachment } from "./attachment";
import { fakeChatStore } from "./fakeChatStore";

export type MattermostReply = {
  channelId: string;
  rootId?: string;
  message: string;
};

export class MattermostClient {
  private readonly usernameCache = new Map<string, string>();

  async postMessage(reply: MattermostReply) {
    if (config.mattermost.fakeMode) {
      fakeChatStore.addBot(reply);
      log.info("Fake Mattermost reply", {
        channelId: reply.channelId,
        rootId: reply.rootId,
        message: reply.message
      });
      return;
    }

    if (config.mattermost.baseUrl && config.mattermost.botToken) {
      await this.postViaRestApi(reply);
      return;
    }

    if (config.mattermost.incomingWebhookUrl) {
      await this.postViaWebhook(reply);
      return;
    }

    throw new Error("Mattermost post requires either MATTERMOST_BOT_TOKEN or MATTERMOST_INCOMING_WEBHOOK_URL");
  }

  private async postViaRestApi(reply: MattermostReply) {
    const url = `${config.mattermost.baseUrl.replace(/\/$/, "")}/api/v4/posts`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.mattermost.botToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        channel_id: reply.channelId,
        root_id: reply.rootId,
        message: "",
        props: {
          attachments: [formatAttachment(reply.message)]
        }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mattermost post failed: HTTP ${response.status} ${body}`);
    }
  }

  async getUsernameById(userId: string) {
    if (!userId) return undefined;
    const cached = this.usernameCache.get(userId);
    if (cached) return cached;

    if (config.mattermost.fakeMode) return undefined;

    const url = `${config.mattermost.baseUrl.replace(/\/$/, "")}/api/v4/users/${encodeURIComponent(userId)}`;
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${config.mattermost.botToken}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      log.warn("Mattermost user lookup failed", {
        userId,
        status: response.status,
        body
      });
      return undefined;
    }

    const user = (await response.json()) as { username?: unknown };
    const username = typeof user.username === "string" ? user.username : undefined;
    if (username) this.usernameCache.set(userId, username);
    return username;
  }

  async getUsernameForMessage(message: { userId: string; username?: string }) {
    return message.username || (await this.getUsernameById(message.userId));
  }

  private async postViaWebhook(reply: MattermostReply) {
    const response = await fetch(config.mattermost.incomingWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachments: [formatAttachment(reply.message)]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mattermost webhook post failed: HTTP ${response.status} ${body}`);
    }
  }
}
