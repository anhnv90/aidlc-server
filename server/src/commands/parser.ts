import type { ParsedCommand, RuleAction, RuleUpdateCommand } from "../domain/types";

const structuredKeys = new Set(["change", "rule_id", "target", "title", "content", "acceptance"]);

export function parseBotCommand(rawMessage: string, botUsername: string): ParsedCommand {
  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}\\b`, "i");
  if (!mentionPattern.test(rawMessage)) {
    return { kind: "ignored", reason: "bot mention not found" };
  }

  const withoutMention = rawMessage.replace(mentionPattern, " ").trim();
  if (!withoutMention) return { kind: "help" };

  const firstLine = withoutMention.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^rule\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(firstLine);
  if (!match) {
    return {
      kind: "ask",
      command: {
        type: "ask",
        query: withoutMention,
        classifyRuleScope: true
      }
    };
  }

  const verb = match[1].toLowerCase();
  const inlineRest = (match[2] ?? "").trim();

  if (verb === "ask" || verb === "search") {
    const query = inlineRest || withoutMention.slice(firstLine.length).trim();
    if (!query) return { kind: "help", reason: "missing search query" };
    return { kind: "ask", command: { type: "ask", query } };
  }

  if (verb === "add" || verb === "update" || verb === "delete") {
    return parseRuleUpdate(verb, withoutMention.slice(firstLine.length).trim());
  }

  return {
    kind: "ask",
    command: {
      type: "ask",
      query: withoutMention,
      classifyRuleScope: true
    }
  };
}

function parseRuleUpdate(action: RuleAction, body: string): ParsedCommand {
  const fields = parseFields(body);
  const ruleId = fields.rule_id?.trim();
  if (!ruleId) return { kind: "help", reason: "missing required field: rule_id" };

  const command: RuleUpdateCommand = {
    type: action,
    ruleId,
    targetFiles: splitList(fields.target),
    title: fields.title?.trim(),
    content: fields.content?.trim(),
    acceptance: fields.acceptance?.trim()
  };

  if (action === "add") {
    if (!command.targetFiles.length) return { kind: "help", reason: "rule add requires target" };
    if (!command.title) return { kind: "help", reason: "rule add requires title" };
    if (!command.content) return { kind: "help", reason: "rule add requires content" };
  }

  if (action === "update" && !command.content) {
    return { kind: "help", reason: "rule update requires content" };
  }

  return { kind: "rule-update", command };
}

function parseFields(body: string) {
  const lines = body.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of lines) {
    const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (keyMatch && structuredKeys.has(keyMatch[1].toLowerCase())) {
      currentKey = keyMatch[1].toLowerCase();
      fields[currentKey] = keyMatch[2] ?? "";
      continue;
    }

    if (currentKey) {
      fields[currentKey] = `${fields[currentKey]}\n${line}`;
    }
  }

  return fields;
}

function splitList(value?: string) {
  if (!value) return [];
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatHelp(reason?: string) {
  const prefix = reason ? `${reason}\n\n` : "";
  return `${prefix}Supported commands:

Ask/search:
@claude <question>
or
@claude rule ask <question>

Add:
@claude rule add
rule_id: DOD-UI-01
target: aidlc-rules/.aidlc-rule-details/construction/build-and-test.md
title: Browser-based user journey is required before Done
content:
  ...

Update:
@claude rule update
rule_id: NP-TST-01
content:
  ...

Delete:
@claude rule delete
rule_id: NP-TST-01`;
}
