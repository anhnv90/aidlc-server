import { config } from "../config";
import type { MattermostMessage, RuleUpdateCommand } from "../domain/types";
import { createPullRequest } from "../github/prClient";
import { runGit, sanitizeBranchPart } from "../git/gitRunner";
import { log } from "../log";
import { applyMarkdownRuleEdit } from "./markdownRuleEditor";

export type RuleUpdateResult = {
  branch: string;
  prUrl: string;
  changedFiles: string[];
  summary: string;
};

export async function applyRuleUpdate(command: RuleUpdateCommand, message: MattermostMessage): Promise<RuleUpdateResult> {
  const branch = buildBranchName(command.ruleId, command.type);

  if (config.ruleUpdateDryRun) {
    log.info("Rule update dry-run completed", {
      action: command.type,
      ruleId: command.ruleId,
      branch
    });
    return {
      branch,
      prUrl: `https://github.example.local/${config.github.owner || "org"}/${config.github.repo || "aidlc"}/pull/dry-run-${Date.now()}`,
      changedFiles: command.targetFiles,
      summary: "Dry-run mode: no files were changed, no git commit was created, and no GitHub PR was opened."
    };
  }

  await prepareBranch(branch);
  const editResult = applyMarkdownRuleEdit(command);

  const changedFiles = await getChangedFiles();
  if (changedFiles.length === 0) {
    throw new Error("Rule editor completed but no files were changed");
  }
  enforceAllowedChangedFiles(changedFiles);

  await runGit(["add", ...changedFiles], config.aidlcRepoPath);
  await runGit(["commit", "-m", buildCommitMessage(command)], config.aidlcRepoPath);
  await runGit(["push", "-u", "origin", branch], config.aidlcRepoPath, 300000);

  const prUrl = await createPullRequest({
    title: buildPrTitle(command),
    body: buildPrBody(command, message, branch, changedFiles, editResult.summary),
    head: branch,
    base: config.github.baseBranch
  });

  return {
    branch,
    prUrl,
    changedFiles,
    summary: editResult.summary
  };
}

async function prepareBranch(branch: string) {
  const status = await runGit(["status", "--porcelain"], config.aidlcRepoPath);
  if (status.trim()) {
    throw new Error("AIDLC_REPO_PATH has uncommitted changes. Use a clean dedicated clone for real update mode.");
  }

  await runGit(["fetch", "origin", config.github.baseBranch], config.aidlcRepoPath, 300000);
  await runGit(["checkout", config.github.baseBranch], config.aidlcRepoPath);
  await runGit(["pull", "--ff-only", "origin", config.github.baseBranch], config.aidlcRepoPath, 300000);
  await runGit(["checkout", "-b", branch], config.aidlcRepoPath);
}

async function getChangedFiles() {
  const output = await runGit(["diff", "--name-only"], config.aidlcRepoPath);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function enforceAllowedChangedFiles(files: string[]) {
  const allowedPrefixes = ["aidlc-rules/", "process/", "onboarding/"];
  const invalid = files.filter((file) => !allowedPrefixes.some((prefix) => normalizePath(file).startsWith(prefix)));
  if (invalid.length > 0) {
    throw new Error(`Claude changed files outside allowed rule paths: ${invalid.join(", ")}`);
  }
}

function buildBranchName(ruleId: string, action: string) {
  return `${sanitizeBranchPart(action)}-${sanitizeBranchPart(ruleId)}-${formatLocalTimestamp()}`;
}

function formatLocalTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());
  const minute = pad(now.getMinutes());
  const second = pad(now.getSeconds());
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function buildCommitMessage(command: RuleUpdateCommand) {
  return `${command.type} AI-DLC rule ${command.ruleId}`;
}

function buildPrTitle(command: RuleUpdateCommand) {
  return `${capitalize(command.type)} AI-DLC rule ${command.ruleId}`;
}

function buildPrBody(
  command: RuleUpdateCommand,
  message: MattermostMessage,
  branch: string,
  changedFiles: string[],
  claudeSummary: string
) {
  return `## AI-DLC Rule Update

- Action: ${command.type}
- Rule ID: ${command.ruleId}
- Branch: ${branch}
- Mattermost post ID: ${message.postId}
- Mattermost channel ID: ${message.channelId}
- Requested by: ${message.username ?? message.userId}

## Changed Files

${changedFiles.map((file) => `- ${file}`).join("\n")}

## Original Command

\`\`\`text
${message.message}
\`\`\`

## Claude Summary

\`\`\`text
${claudeSummary}
\`\`\`
`;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
