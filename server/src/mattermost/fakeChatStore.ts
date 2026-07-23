import type { MattermostMessage } from "../domain/types";
import { formatAttachment, type MattermostAttachment } from "./attachment";

export type FakeChatMessage = {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  role: "user" | "bot";
  message: string;
  attachments?: MattermostAttachment[];
  rootId?: string;
  createdAt: string;
};

const messages: FakeChatMessage[] = [];
const maxMessages = 500;

export const fakeChatStore = {
  addUser(message: MattermostMessage) {
    add({
      id: message.postId,
      channelId: message.channelId,
      userId: message.userId,
      username: message.username ?? message.userId,
      role: "user",
      message: message.message,
      rootId: message.rootId,
      createdAt: message.createdAt
    });
  },

  addBot(input: { channelId: string; message: string; rootId?: string }) {
    add({
      id: `fake-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId: input.channelId,
      userId: "bot-user-id",
      username: "claude",
      role: "bot",
      message: input.message,
      attachments: [formatAttachment(input.message)],
      rootId: input.rootId,
      createdAt: new Date().toISOString()
    });
  },

  list() {
    return [...messages];
  },

  clear() {
    messages.length = 0;
  }
};

function add(message: FakeChatMessage) {
  messages.push(message);
  if (messages.length > maxMessages) {
    messages.splice(0, messages.length - maxMessages);
  }
}
