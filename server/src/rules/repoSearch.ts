import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { config } from "../config";

export type SearchHit = {
  file: string;
  score: number;
  snippet: string;
};

const searchRoots = ["aidlc-rules", "process", "onboarding"];
const maxSnippetChars = 1600;

export function searchRuleRepo(query: string, limit = 8): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const file of listMarkdownFiles()) {
    const absPath = resolve(config.aidlcRepoPath, file);
    const text = readFileSync(absPath, "utf8");
    const score = scoreText(text, terms, file);
    if (score <= 0) continue;
    hits.push({
      file,
      score,
      snippet: buildSnippet(text, terms)
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function listMarkdownFiles() {
  const files: string[] = [];
  for (const root of searchRoots) {
    const absRoot = resolve(config.aidlcRepoPath, root);
    if (!existsSync(absRoot)) continue;
    walk(absRoot, files);
  }
  return files.sort();
}

function walk(absDir: string, files: string[]) {
  for (const entry of readdirSync(absDir)) {
    const absPath = resolve(absDir, entry);
    const stats = statSync(absPath);
    if (stats.isDirectory()) {
      walk(absPath, files);
    } else if (stats.isFile() && absPath.toLowerCase().endsWith(".md")) {
      files.push(relative(config.aidlcRepoPath, absPath).replace(/\\/g, "/"));
    }
  }
}

function scoreText(text: string, terms: string[], file: string) {
  const lowerText = text.toLowerCase();
  const lowerFile = file.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerFile.includes(term)) score += 8;
    const matches = lowerText.match(new RegExp(escapeRegExp(term), "g"));
    if (matches) score += matches.length;
  }
  return score;
}

function buildSnippet(text: string, terms: string[]) {
  const lowerText = text.toLowerCase();
  const firstHit = terms
    .map((term) => lowerText.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstHit === undefined) {
    return text.slice(0, maxSnippetChars);
  }

  const start = Math.max(0, firstHit - 500);
  const end = Math.min(text.length, firstHit + maxSnippetChars);
  return text.slice(start, end).trim();
}

function tokenize(query: string) {
  const normalized = query
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  return Array.from(new Set(normalized));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

