import { config } from "../config";
import { runClaude } from "../claude/runner";
import { GraphStore } from "../graph/graphStore";

type AskRuleOptions = {
  classifyRuleScope?: boolean;
};

type QuestionIntent = "rule" | "source_graph" | "mixed" | "general";

type QuestionClassification = {
  intent: QuestionIntent;
  reason?: string;
};

export async function askRule(query: string, options: AskRuleOptions = {}) {
  if (options.classifyRuleScope) {
    const classification = await classifyQuestionIntent(query);
    if (classification.intent === "general") {
      return answerGeneralQuestion(query);
    }
    if (classification.intent === "source_graph") {
      return askSourceGraph(query, classification);
    }
    if (classification.intent === "mixed") {
      return askMixedRuleAndGraph(query, classification);
    }
  }

  return askRuleWithAgent(query);
}

async function classifyQuestionIntent(query: string): Promise<QuestionClassification> {
  const prompt = `You are the AI-DLC Mattermost Question Intent Classifier.

The user mentioned @claude in Mattermost with this message:
${query}

Task:
Decide which knowledge source is required.

Choose exactly one intent:

- "rule": the user asks about AI-DLC rules, process, playbook, Definition of Done, testing rules, development lifecycle, reverse engineering rules, design/detailing rules, source restrictions, PR/checksheet requirements, or whether a rule exists.
- "source_graph": the user asks about application source code, UI screens, backend endpoints, classes, methods, repositories, entities, tables, DDD/business flow, persistence, or source-code-derived business knowledge.
- "mixed": the user asks to evaluate source-code behavior against AI-DLC rules, or asks a question that clearly needs both rule knowledge and source graph evidence.
- "general": greeting, server operation request, Mattermost usage question, general programming question, or anything that does not require AI-DLC rules or source graph.

Examples:
- "RESILIENCY-02 nói gì?" => "rule"
- "Rule có bắt buộc test browser không?" => "rule"
- "Màn hình JAM001 gọi endpoint nào?" => "source_graph"
- "RemandCommandHandler xử lý nghiệp vụ gì?" => "source_graph"
- "Repository nào dùng bảng JRQMT_APP_SETTING?" => "source_graph"
- "Theo rule AIDLC thì flow JAM001 đã đủ Done chưa?" => "mixed"
- "hello" => "general"

Rules:
- Do not inspect local files.
- Do not search the web.
- Output JSON only, with this exact shape:
{
  "intent": "source_graph",
  "reason": "short reason"
}

Do not answer the user's question in this classifier response. Only classify the intent.`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }

  const parsed = parseClassifierJson(result.stdout);
  if (!parsed) {
    throw new Error(`Claude classifier returned invalid JSON: ${result.stdout || "(empty response)"}`);
  }

  return parsed;
}

function parseClassifierJson(value: string) {
  const compact = value.trim();
  const jsonText = compact.match(/\{[\s\S]*\}/)?.[0] ?? compact;
  try {
    const parsed = JSON.parse(jsonText) as {
      intent?: unknown;
      reason?: unknown;
    };
    if (!isQuestionIntent(parsed.intent)) return null;
    return {
      intent: parsed.intent,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined
    };
  } catch {
    return null;
  }
}

async function answerGeneralQuestion(query: string) {
  const prompt = `You are Claude responding to a Mattermost mention.

The user mentioned @claude with this message:
${query}

The message was classified as NOT requiring AI-DLC rule repository search or source graph search.

Task:
Answer the user's question directly as a general assistant.

Rules:
- Do not search the AI-DLC rule repository.
- Do not use the source graph.
- Do not search Mattermost history.
- Do not use external web sources.
- Do not claim that a rule exists or does not exist because this is not a rule-search answer.
- Do not ask what the user wants to do unless the message is truly ambiguous.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- If the response language is ambiguous, answer in English.
- Keep the answer practical and concise.`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}

async function askSourceGraph(query: string, classification?: QuestionClassification) {
  const evidence = collectGraphEvidence(query);
  const prompt = `You are Claude answering a Mattermost question using the AIDLC business/source graph.

The user asked:
${query}

Intent classification:
${JSON.stringify(classification ?? { intent: "source_graph" }, null, 2)}

Graph evidence from SQLite:
${JSON.stringify(evidence, null, 2)}

Task:
Answer using only the graph evidence above.

Rules:
- Do not inspect local source files directly.
- Do not search the web.
- Do not invent source-code behavior that is not supported by graph evidence.
- If graph evidence is insufficient, say that clearly and suggest a more specific screen/class/table/endpoint keyword.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- Include concrete graph references when available: node id, kind, project, path/source_file, line, endpoint, table, class, or method.
- Keep the answer practical and concise.
- Start with one of: "Status: found", "Status: partial", or "Status: not_found".`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}

async function askMixedRuleAndGraph(query: string, classification?: QuestionClassification) {
  const evidence = collectGraphEvidence(query);
  const prompt = `You are Claude Code running inside the AI-DLC repository and answering a Mattermost question.

The user asked:
${query}

Intent classification:
${JSON.stringify(classification ?? { intent: "mixed" }, null, 2)}

Graph evidence from SQLite:
${JSON.stringify(evidence, null, 2)}

Task:
Answer by combining:
1. AI-DLC rule repository knowledge from local files, especially:
   - aidlc-rules/
   - process/
   - onboarding/
2. Source/business graph evidence shown above.

Rules:
- Do not inspect application source code directly.
- You may inspect the AI-DLC rule repository paths listed above.
- Do not search the web.
- Do not search Mattermost history.
- Do not invent source-code behavior that is not supported by graph evidence.
- If either rule evidence or graph evidence is insufficient, say which side is missing.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- Include concrete rule file paths/rule IDs and graph references when available.
- Keep the answer practical and concise.
- Start with one of: "Status: exists", "Status: partial", or "Status: not_found".`;

  const result = await runClaude(prompt, config.aidlcRepoPath);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}

function collectGraphEvidence(query: string) {
  const store = new GraphStore(config.graph.sqliteDbPath);
  const candidates = extractGraphQueries(query).slice(0, 6);
  const evidence: Record<string, unknown> = {
    database: config.graph.sqliteDbPath,
    candidates,
    graph_stats: safeGraphCall(() => store.graphStats()),
    searches: [],
    screen_traces: [],
    repository_persistence: [],
    method_calls_type: [],
    expansions: []
  };

  const searches = evidence.searches as unknown[];
  const screenTraces = evidence.screen_traces as unknown[];
  const repositoryPersistence = evidence.repository_persistence as unknown[];
  const methodCallsType = evidence.method_calls_type as unknown[];
  const expansions = evidence.expansions as unknown[];
  const expanded = new Set<string>();

  for (const candidate of candidates) {
    const search = safeGraphCall(() => store.searchNodes({ query: candidate, limit: 8 }));
    searches.push({ candidate, result: search });

    const nodes = graphNodes(search).slice(0, 1);
    for (const node of nodes) {
      const id = typeof node.id === "string" ? node.id : "";
      if (!id || expanded.has(id)) continue;
      expanded.add(id);
      expansions.push({
        candidate,
        id,
        result: safeGraphCall(() => store.expandNode({ id, depth: 1, direction: "both", limit: 35 }))
      });
    }

    if (candidate.includes("/")) {
      screenTraces.push({
        candidate,
        result: safeGraphCall(() => store.traceScreen({ screen: candidate, limit: 25 }))
      });
    }

    if (/repository/i.test(candidate)) {
      repositoryPersistence.push({
        candidate,
        result: safeGraphCall(() => store.repositoryPersistence({ repository: candidate, limit: 25 }))
      });
    }

    if (/[A-Z][A-Za-z0-9_]{2,}/.test(candidate)) {
      methodCallsType.push({
        candidate,
        result: safeGraphCall(() => store.methodCallsType({ query: candidate, limit: 25 }))
      });
    }
  }

  return evidence;
}

function extractGraphQueries(query: string) {
  const found: string[] = [];
  const add = (value?: string) => {
    const cleaned = (value ?? "").trim().replace(/^[`'"]+|[`'",.;:!?]+$/g, "");
    if (cleaned.length >= 2 && !found.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      found.push(cleaned);
    }
  };

  const patterns = [
    /\b[a-z]{2,}\/[a-z0-9_./-]+\b/gi,
    /\b[A-Z][A-Za-z0-9_]*(?:CommandHandler|Handler|Repository|Finder|Service|WebService|Controller|Command|Dto|DTO|Entity|Table)\b/g,
    /\b[A-Z][A-Z0-9_]{4,}\b/g,
    /\buk\.[A-Za-z0-9_.-]+\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of query.matchAll(pattern)) {
      add(match[0].replace(/\([^)]*\)$/, ""));
    }
  }

  const words = query
    .split(/[\s,;:!?()[\]{}"'`]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length >= 4)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()));

  for (const word of words) {
    if (/^[A-Za-z0-9_.\/-]+$/.test(word) || /[A-Z0-9_]/.test(word)) {
      add(word);
    }
  }

  if (found.length === 0) {
    add(query.length <= 80 ? query : undefined);
  }
  return found;
}

function safeGraphCall<T>(fn: () => T) {
  try {
    return fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function graphNodes(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const nodes = (value as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
}

function isQuestionIntent(value: unknown): value is QuestionIntent {
  return value === "rule" || value === "source_graph" || value === "mixed" || value === "general";
}

const STOP_WORDS = new Set([
  "cua",
  "của",
  "cho",
  "toi",
  "tôi",
  "trong",
  "ngoai",
  "ngoài",
  "nhung",
  "những",
  "dang",
  "đang",
  "duoc",
  "được",
  "khong",
  "không",
  "nao",
  "nào",
  "the",
  "thế",
  "hay",
  "voi",
  "với",
  "this",
  "that",
  "what",
  "which",
  "where",
  "when",
  "does",
  "from",
  "source",
  "code",
  "screen",
  "class",
  "method",
  "repository",
  "endpoint",
  "table",
  "flow",
  "rule",
  "rules",
  "man",
  "màn",
  "hinh",
  "hình",
  "goi",
  "gọi",
  "xu",
  "xử",
  "ly",
  "lý",
  "nghiep",
  "nghiệp",
  "vu",
  "vụ"
]);

async function askRuleWithAgent(query: string) {
  const prompt = `You are Claude Code running inside the AI-DLC repository.

The user asked this Mattermost question:
${query}

Task:
Answer by inspecting the local repository directly, especially these paths when relevant:
- aidlc-rules/
- process/
- onboarding/

Rules:
- Do not use external web sources.
- Do not search Mattermost history.
- Do not ask what the user wants to do.
- Do not mention the current git branch unless it directly affects the answer.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- If the response language is ambiguous, answer in English.
- Keep the required status prefix exactly in English.
- Start with one of: "Status: exists", "Status: partial", or "Status: not_found".
- Include concrete source file paths and rule IDs/headings when found.
- If the rule only partially exists, explain what is missing.
- Keep the answer practical and concise.`;

  const result = await runClaude(prompt, config.aidlcRepoPath);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}
