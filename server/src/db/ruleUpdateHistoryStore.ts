import type Database from "better-sqlite3";
import type { MattermostMessage, RuleAction, RuleUpdateHistory, RuleUpdateStatus } from "../domain/types";

type CreateRuleUpdateInput = {
  message: MattermostMessage;
  action: RuleAction;
  ruleId: string;
  title?: string;
  targetFiles: string[];
};

type ListFilters = {
  status?: string;
  ruleId?: string;
  user?: string;
  q?: string;
};

type DbRow = {
  id: number;
  mattermost_post_id: string | null;
  mattermost_channel_id: string;
  mattermost_user_id: string;
  mattermost_username: string | null;
  command_text: string;
  action: RuleAction;
  rule_id: string;
  title: string | null;
  target_files_json: string;
  status: RuleUpdateStatus;
  git_branch: string | null;
  github_pr_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export class RuleUpdateHistoryStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateRuleUpdateInput) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        INSERT INTO rule_update_history (
          mattermost_post_id,
          mattermost_channel_id,
          mattermost_user_id,
          mattermost_username,
          command_text,
          action,
          rule_id,
          title,
          target_files_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `
      )
      .run(
        input.message.postId,
        input.message.channelId,
        input.message.userId,
        input.message.username ?? null,
        input.message.message,
        input.action,
        input.ruleId,
        input.title ?? null,
        JSON.stringify(input.targetFiles),
        now,
        now
      );

    return Number(result.lastInsertRowid);
  }

  updateStatus(
    id: number,
    status: RuleUpdateStatus,
    updates: {
      gitBranch?: string | null;
      githubPrUrl?: string | null;
      errorMessage?: string | null;
    } = {}
  ) {
    this.db
      .prepare(
        `
        UPDATE rule_update_history
        SET status = ?,
            git_branch = COALESCE(?, git_branch),
            github_pr_url = COALESCE(?, github_pr_url),
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        status,
        updates.gitBranch ?? null,
        updates.githubPrUrl ?? null,
        updates.errorMessage ?? null,
        new Date().toISOString(),
        id
      );
  }

  get(id: number) {
    const row = this.db.prepare("SELECT * FROM rule_update_history WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filters: ListFilters) {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.ruleId) {
      clauses.push("rule_id LIKE ?");
      params.push(`%${filters.ruleId}%`);
    }
    if (filters.user) {
      clauses.push("(mattermost_user_id LIKE ? OR mattermost_username LIKE ?)");
      params.push(`%${filters.user}%`, `%${filters.user}%`);
    }
    if (filters.q) {
      clauses.push("(command_text LIKE ? OR title LIKE ? OR error_message LIKE ?)");
      params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM rule_update_history ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params) as DbRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: DbRow): RuleUpdateHistory {
  return {
    id: row.id,
    mattermostPostId: row.mattermost_post_id,
    mattermostChannelId: row.mattermost_channel_id,
    mattermostUserId: row.mattermost_user_id,
    mattermostUsername: row.mattermost_username,
    commandText: row.command_text,
    action: row.action,
    ruleId: row.rule_id,
    title: row.title,
    targetFiles: parseTargetFiles(row.target_files_json),
    status: row.status,
    gitBranch: row.git_branch,
    githubPrUrl: row.github_pr_url,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseTargetFiles(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

