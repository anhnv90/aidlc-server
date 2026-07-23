import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";

export function openDatabase() {
  mkdirSync(dirname(config.sqliteDbPath), { recursive: true });
  const db = new Database(config.sqliteDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mattermost_post_id TEXT,
      mattermost_channel_id TEXT NOT NULL,
      mattermost_user_id TEXT NOT NULL,
      mattermost_username TEXT,
      command_text TEXT NOT NULL,
      action TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      title TEXT,
      target_files_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      git_branch TEXT,
      github_pr_url TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rule_update_history_created_at
      ON rule_update_history(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_rule_update_history_rule_id
      ON rule_update_history(rule_id);

    CREATE INDEX IF NOT EXISTS idx_rule_update_history_status
      ON rule_update_history(status);
  `);
}

