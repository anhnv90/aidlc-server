import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

dotenv.config();

function getString(name: string, defaultValue = "") {
  return process.env[name]?.trim() || defaultValue;
}

function getNumber(name: string, defaultValue: number) {
  const value = getString(name);
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }
  return parsed;
}

function getBoolean(name: string, defaultValue: boolean) {
  const value = getString(name);
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getCsv(name: string) {
  return getString(name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveFromCwd(pathValue: string) {
  return resolve(process.cwd(), pathValue);
}

export type AppConfig = {
  serverPort: number;
  dashboardDistDir: string;
  sqliteDbPath: string;
  auth: {
    username: string;
    password: string;
    sessionTtlHours: number;
  };
  graph: {
    rootPath: string;
    outputRootPath: string;
    businessGraphDir: string;
    sqliteDbPath: string;
    pythonExe: string;
    joernImage: string;
    mcpEndpoint: string;
  };
  mattermost: {
    fakeMode: boolean;
    baseUrl: string;
    botToken: string;
    botUserId: string;
    botUsername: string;
    allowedChannelIds: Set<string>;
    incomingWebhookUrl: string;
  };
  ruleUpdateAuthorizedUsernames: Set<string>;
  aidlcRepoPath: string;
  github: {
    owner: string;
    repo: string;
    token: string;
    baseBranch: string;
  };
  ruleUpdateDryRun: boolean;
  claude: {
    fakeMode: boolean;
    command: string;
    timeoutMs: number;
    extraArgs: string[];
  };
};

export const config: AppConfig = {
  serverPort: getNumber("SERVER_PORT", 3003),
  dashboardDistDir: resolveFromCwd(getString("DASHBOARD_DIST_DIR", "./dist/dashboard")),
  sqliteDbPath: resolveFromCwd(getString("SQLITE_DB_PATH", "./data/aidlc-server.db")),
  auth: {
    username: getString("AUTH_USERNAME", "admin"),
    password: getString("AUTH_PASSWORD", "admin123"),
    sessionTtlHours: getNumber("AUTH_SESSION_TTL_HOURS", 12)
  },
  graph: buildGraphConfig(),
  mattermost: {
    fakeMode: getBoolean("MATTERMOST_FAKE_MODE", true),
    baseUrl: getString("MATTERMOST_BASE_URL"),
    botToken: getString("MATTERMOST_BOT_TOKEN"),
    botUserId: getString("MATTERMOST_BOT_USER_ID", "bot-user-id"),
    botUsername: getString("MATTERMOST_BOT_USERNAME", "claude"),
    allowedChannelIds: new Set(getCsv("MATTERMOST_ALLOWED_CHANNEL_IDS")),
    incomingWebhookUrl: getString("MATTERMOST_INCOMING_WEBHOOK_URL")
  },
  ruleUpdateAuthorizedUsernames: new Set(getCsv("RULE_UPDATE_AUTHORIZED_USERNAMES").map(normalizeUsername)),
  aidlcRepoPath: getString("AIDLC_REPO_PATH", process.cwd()),
  github: {
    owner: getString("GITHUB_OWNER"),
    repo: getString("GITHUB_REPO"),
    token: getString("GITHUB_TOKEN"),
    baseBranch: getString("GITHUB_BASE_BRANCH", "main")
  },
  ruleUpdateDryRun: getBoolean("RULE_UPDATE_DRY_RUN", true),
  claude: {
    fakeMode: getBoolean("CLAUDE_FAKE_MODE", true),
    command: getString("CLAUDE_COMMAND", "claude"),
    timeoutMs: getNumber("CLAUDE_TIMEOUT_MS", 300000),
    extraArgs: getCsv("CLAUDE_EXTRA_ARGS")
  }
};

function buildGraphConfig() {
  const rootPath = resolveFromCwd("./graph");
  const defaultOutputRootPath = resolveFromCwd("./data/graph-output");
  const rawSqliteDbPath = getString("GRAPH_SQLITE_DB_PATH");
  const outputRootPath = resolve(
    getString("GRAPH_OUTPUT_ROOT_PATH", rawSqliteDbPath ? dirname(resolve(rawSqliteDbPath)) : defaultOutputRootPath)
  );
  const sqliteDbPath = resolve(rawSqliteDbPath || resolve(outputRootPath, "graph.sqlite"));
  const businessGraphDir = resolve(outputRootPath, "business-graph");
  return {
    rootPath,
    outputRootPath,
    businessGraphDir,
    sqliteDbPath,
    pythonExe: getString("GRAPH_PYTHON_EXE", "C:\\Users\\anhnv\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"),
    joernImage: getString("GRAPH_JOERN_IMAGE", "ghcr.io/joernio/joern:nightly"),
    mcpEndpoint: normalizeEndpoint(getString("GRAPH_MCP_ENDPOINT", "/mcp"))
  };
}

export function validateConfig() {
  if (!existsSync(config.aidlcRepoPath)) {
    throw new Error(`AIDLC_REPO_PATH does not exist: ${config.aidlcRepoPath}`);
  }
  if (!existsSync(config.graph.rootPath)) {
    throw new Error(`Bundled graph runtime path does not exist: ${config.graph.rootPath}`);
  }
  if (!config.mattermost.fakeMode) {
    if (!config.mattermost.baseUrl) throw new Error("MATTERMOST_BASE_URL is required in real mode");
    if (!config.mattermost.botToken) throw new Error("MATTERMOST_BOT_TOKEN is required in real mode");
    if (!config.mattermost.botUserId) throw new Error("MATTERMOST_BOT_USER_ID is required in real mode");
  }
  if (!config.ruleUpdateDryRun) {
    if (!config.github.owner) throw new Error("GITHUB_OWNER is required when RULE_UPDATE_DRY_RUN=false");
    if (!config.github.repo) throw new Error("GITHUB_REPO is required when RULE_UPDATE_DRY_RUN=false");
    if (!config.github.token) throw new Error("GITHUB_TOKEN is required when RULE_UPDATE_DRY_RUN=false");
  }
}

function normalizeUsername(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function normalizeEndpoint(value: string) {
  const endpoint = value.trim() || "/mcp";
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}
