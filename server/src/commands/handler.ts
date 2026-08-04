import { config } from "../config";
import { formatHelp, parseBotCommand } from "./parser";
import type { MattermostMessage } from "../domain/types";
import { MattermostClient } from "../mattermost/client";
import { RuleUpdateHistoryStore } from "../db/ruleUpdateHistoryStore";
import { askRule } from "../rules/askRule";
import { applyRuleUpdate } from "../rules/updateRule";
import { log } from "../log";
import type { ParsedCommand } from "../domain/types";

type QueuedCommand = Extract<ParsedCommand, { kind: "ask" }> | Extract<ParsedCommand, { kind: "rule-update" }>;

type QueuedJob = {
  id: number;
  message: MattermostMessage;
  parsed: QueuedCommand;
  historyId?: number;
};

export class CommandHandler {
  private readonly queue: QueuedJob[] = [];
  private readonly seenPostIds = new Set<string>();
  private readonly seenPostIdOrder: string[] = [];
  private processing = false;
  private nextJobId = 1;

  constructor(
    private readonly mattermost: MattermostClient,
    private readonly history: RuleUpdateHistoryStore
  ) {}

  async handle(message: MattermostMessage) {
    if (config.mattermost.allowedChannelIds.size > 0 && !config.mattermost.allowedChannelIds.has(message.channelId)) {
      log.debug("Ignoring message outside allowed channels", { channelId: message.channelId });
      return;
    }

    const parsed = parseBotCommand(message.message, config.mattermost.botUsername);
    if (parsed.kind === "ignored") {
      return;
    }

    if (!this.rememberPostId(message.postId)) {
      log.debug("Ignoring duplicate Mattermost post", { postId: message.postId });
      return;
    }

    log.info("Command received", {
      kind: parsed.kind,
      userId: message.userId,
      username: message.username,
      channelId: message.channelId
    });

    if (parsed.kind === "help") {
      await this.reply(message, formatHelp(parsed.reason));
      return;
    }

    if (parsed.kind === "ask") {
      await this.enqueue(message, parsed);
      return;
    }

    const ruleUpdateMessage = await this.withResolvedUsername(message);
    const historyId = this.history.create({
      message: ruleUpdateMessage,
      action: parsed.command.type,
      ruleId: parsed.command.ruleId,
      title: parsed.command.title,
      targetFiles: parsed.command.targetFiles
    });

    if (!this.isAuthorizedRuleUpdater(ruleUpdateMessage)) {
      this.history.updateStatus(historyId, "rejected", {
        errorMessage: `User ${ruleUpdateMessage.username || ruleUpdateMessage.userId} is not authorized to update rules`
      });
      await this.reply(message, "You are not authorized to update rules. This command was rejected.");
      return;
    }

    await this.enqueue(ruleUpdateMessage, parsed, historyId);
  }

  private async enqueue(message: MattermostMessage, parsed: QueuedCommand, historyId?: number) {
    const job: QueuedJob = {
      id: this.nextJobId++,
      message,
      parsed,
      historyId
    };
    this.queue.push(job);

    const statusMessage = this.formatQueuedMessage(job);
    log.info("Command queued", {
      jobId: job.id,
      kind: parsed.kind,
      userId: message.userId,
      username: message.username,
      channelId: message.channelId
    });
    try {
      await this.reply(message, statusMessage);
    } catch (err) {
      log.error("Failed to send queued reply", {
        jobId: job.id,
        error: errorMessage(err)
      });
    }
    this.processQueue();
  }

  private processQueue() {
    if (this.processing) return;
    this.processing = true;
    void this.drainQueue();
  }

  private async drainQueue() {
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) continue;
        log.info("Queued command started", {
          jobId: job.id,
          kind: job.parsed.kind,
          queueRemaining: this.queue.length
        });
        try {
          await this.executeQueuedJob(job);
        } catch (err) {
          const msg = errorMessage(err);
          log.error("Queued command failed unexpectedly", { jobId: job.id, error: msg });
          await this.reply(job.message, `Job #${job.id} failed: ${msg}`);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) this.processQueue();
    }
  }

  private async executeQueuedJob(job: QueuedJob) {
    if (job.parsed.kind === "ask") {
      await this.handleAsk(job.message, job.parsed.command, job.id);
      return;
    }

    if (!job.historyId) {
      throw new Error(`Queued rule update job ${job.id} is missing history id`);
    }
    await this.handleRuleUpdate(job.message, job.parsed.command, job.historyId, job.id);
  }

  private async handleAsk(message: MattermostMessage, command: Extract<QueuedCommand, { kind: "ask" }>["command"], jobId: number) {
    try {
      log.info("Ask job started", { jobId, userId: message.userId, username: message.username });
      const answer = await askRule(command.query, { classifyRuleScope: command.classifyRuleScope });
      await this.reply(message, withJobResponse(jobId, answer));
    } catch (err) {
      const msg = errorMessage(err);
      log.error("Ask job failed", { jobId, error: msg });
      await this.reply(message, withJobResponse(jobId, `Rule search failed: ${msg}`));
    }
  }

  private async handleRuleUpdate(
    message: MattermostMessage,
    command: Parameters<typeof applyRuleUpdate>[0],
    historyId: number,
    jobId: number
  ) {
    try {
      this.history.updateStatus(historyId, "running");
      log.info("Rule update job started", {
        jobId,
        action: command.type,
        ruleId: command.ruleId,
        userId: message.userId,
        username: message.username
      });
      const result = await applyRuleUpdate(command, message);
      this.history.updateStatus(historyId, "pr_created", {
        gitBranch: result.branch,
        githubPrUrl: result.prUrl
      });
      await this.reply(
        message,
        withJobResponse(
          jobId,
          [
            `Created rule update PR for ${command.ruleId}.`,
            "",
            `Action: ${command.type}`,
            `Branch: ${result.branch}`,
            `PR: [Open pull request](${result.prUrl})`,
            "",
            result.summary
          ].join("\n")
        )
      );
    } catch (err) {
      const msg = errorMessage(err);
      this.history.updateStatus(historyId, "failed", { errorMessage: msg });
      await this.reply(message, withJobResponse(jobId, `Rule update failed: ${msg}`));
    }
  }

  private async reply(source: MattermostMessage, message: string) {
    await this.mattermost.postMessage({
      channelId: source.channelId,
      rootId: source.rootId || source.postId,
      message
    });
  }

  private rememberPostId(postId: string) {
    if (!postId) return true;
    if (this.seenPostIds.has(postId)) return false;

    this.seenPostIds.add(postId);
    this.seenPostIdOrder.push(postId);

    while (this.seenPostIdOrder.length > 1000) {
      const oldest = this.seenPostIdOrder.shift();
      if (oldest) this.seenPostIds.delete(oldest);
    }

    return true;
  }

  private formatQueuedMessage(job: QueuedJob) {
    const target =
      job.parsed.kind === "ask"
        ? "ask/search request"
        : `${job.parsed.command.type} request for rule ${job.parsed.command.ruleId}`;

    return `Received ${target}. Queued as job #${job.id}`;
  }

  private async withResolvedUsername(message: MattermostMessage): Promise<MattermostMessage> {
    if (message.username) return message;
    const username = await this.mattermost.getUsernameById(message.userId);
    return username ? { ...message, username } : message;
  }

  private isAuthorizedRuleUpdater(message: MattermostMessage) {
    const username = normalizeUsername(message.username);
    return Boolean(username && config.ruleUpdateAuthorizedUsernames.has(username));
  }
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeUsername(value?: string) {
  return value?.trim().replace(/^@/, "").toLowerCase();
}

function withJobResponse(jobId: number, message: string) {
  return [`Response for job #${jobId}`, "", message].join("\n");
}
