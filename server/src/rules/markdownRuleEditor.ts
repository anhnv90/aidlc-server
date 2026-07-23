import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { RuleUpdateCommand } from "../domain/types";
import { config } from "../config";

const allowedPrefixes = ["aidlc-rules/", "process/", "onboarding/"];

export type MarkdownRuleEditResult = {
  changedFiles: string[];
  summary: string;
};

type RuleBlock = {
  file: string;
  start: number;
  end: number;
  heading: string;
};

export function applyMarkdownRuleEdit(command: RuleUpdateCommand): MarkdownRuleEditResult {
  switch (command.type) {
    case "add":
      return addRule(command);
    case "update":
      return updateRule(command);
    case "delete":
      return deleteRule(command);
  }
}

function addRule(command: RuleUpdateCommand): MarkdownRuleEditResult {
  const target = command.targetFiles[0];
  if (!target) throw new Error("rule add requires at least one target file");
  if (!command.title) throw new Error("rule add requires title");
  if (!command.content) throw new Error("rule add requires content");

  const existing = findRuleBlock(command.ruleId);
  if (existing) {
    throw new Error(`Rule ${command.ruleId} already exists in ${existing.file}`);
  }

  const absPath = resolveRepoFile(target);
  if (!existsSync(absPath)) {
    throw new Error(`Target file does not exist: ${target}`);
  }

  const original = readFileSync(absPath, "utf8");
  const block = formatNewRuleBlock(command);
  const next = `${trimEndNewlines(original)}\n\n${block}\n`;
  writeFileSync(absPath, next, "utf8");

  return {
    changedFiles: [normalizeRelPath(target)],
    summary: `Added rule ${command.ruleId} to ${normalizeRelPath(target)}.`
  };
}

function updateRule(command: RuleUpdateCommand): MarkdownRuleEditResult {
  if (!command.content) throw new Error("rule update requires content");
  const block = findRuleBlock(command.ruleId);
  if (!block) throw new Error(`Rule ${command.ruleId} was not found in allowed rule files`);

  const absPath = resolveRepoFile(block.file);
  const original = readFileSync(absPath, "utf8");
  const replacement = `${block.heading}\n\n${command.content.trim()}\n\n`;
  const next = `${original.slice(0, block.start)}${replacement}${trimLeadingNewlines(original.slice(block.end))}`;
  writeFileSync(absPath, next, "utf8");

  return {
    changedFiles: [block.file],
    summary: `Updated rule ${command.ruleId} in ${block.file}.`
  };
}

function deleteRule(command: RuleUpdateCommand): MarkdownRuleEditResult {
  const block = findRuleBlock(command.ruleId);
  if (!block) throw new Error(`Rule ${command.ruleId} was not found in allowed rule files`);

  const absPath = resolveRepoFile(block.file);
  const original = readFileSync(absPath, "utf8");
  const next = `${trimEndNewlines(original.slice(0, block.start))}\n\n${trimLeadingNewlines(original.slice(block.end))}`;
  writeFileSync(absPath, trimEndNewlines(next) + "\n", "utf8");

  return {
    changedFiles: [block.file],
    summary: `Deleted rule ${command.ruleId} from ${block.file}.`
  };
}

function formatNewRuleBlock(command: RuleUpdateCommand) {
  const lines = [`## ${command.ruleId}: ${command.title?.trim()}`, "", command.content?.trim() ?? ""];
  if (command.acceptance?.trim()) {
    lines.push("", "### Acceptance", "", ...normalizeBullets(command.acceptance));
  }
  return lines.join("\n");
}

function normalizeBullets(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? line : `- ${line.replace(/^-\s*/, "")}`));
}

function findRuleBlock(ruleId: string): RuleBlock | null {
  const needle = ruleId.toLowerCase();
  for (const file of listMarkdownFiles()) {
    const absPath = resolveRepoFile(file);
    const text = readFileSync(absPath, "utf8");
    const headings = Array.from(text.matchAll(/^(#{1,6})\s+(.+)$/gm));
    for (let index = 0; index < headings.length; index++) {
      const match = headings[index];
      const headingText = match[0];
      if (!headingText.toLowerCase().includes(needle)) continue;

      const level = match[1].length;
      const start = match.index ?? 0;
      let end = text.length;
      for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex++) {
        const next = headings[nextIndex];
        const nextLevel = next[1].length;
        if (nextLevel <= level) {
          end = next.index ?? text.length;
          break;
        }
      }
      return {
        file,
        start,
        end,
        heading: headingText
      };
    }
  }
  return null;
}

function listMarkdownFiles() {
  const files: string[] = [];
  for (const prefix of allowedPrefixes) {
    const absDir = resolveRepoFile(prefix);
    if (!existsSync(absDir)) continue;
    walk(absDir, files);
  }
  return files.sort();
}

function walk(absDir: string, files: string[]) {
  for (const entry of readdirSync(absDir)) {
    const absPath = resolve(absDir, entry);
    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      walk(absPath, files);
      continue;
    }
    if (stats.isFile() && absPath.toLowerCase().endsWith(".md")) {
      files.push(toRepoRelative(absPath));
    }
  }
}

function resolveRepoFile(file: string) {
  const normalized = normalizeRelPath(file);
  ensureAllowedPath(normalized);
  const absPath = resolve(config.aidlcRepoPath, normalized);
  const repoRoot = resolve(config.aidlcRepoPath);
  if (absPath !== repoRoot && !absPath.startsWith(`${repoRoot}\\`) && !absPath.startsWith(`${repoRoot}/`)) {
    throw new Error(`Resolved path escapes repo root: ${file}`);
  }
  return absPath;
}

function ensureAllowedPath(file: string) {
  if (!allowedPrefixes.some((prefix) => file.startsWith(prefix))) {
    throw new Error(`Rule edits are only allowed under ${allowedPrefixes.join(", ")}. Got: ${file}`);
  }
}

function toRepoRelative(absPath: string) {
  return normalizeRelPath(relative(config.aidlcRepoPath, absPath));
}

function normalizeRelPath(file: string) {
  return file.replace(/\\/g, "/").replace(/^\/+/, "");
}

function trimEndNewlines(value: string) {
  return value.replace(/\s+$/g, "");
}

function trimLeadingNewlines(value: string) {
  return value.replace(/^\s+/g, "");
}

