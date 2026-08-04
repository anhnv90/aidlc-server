import { config } from "../config";
import { runClaude, type ClaudeResult } from "../claude/runner";
import { GraphStore } from "../graph/graphStore";
import { log } from "../log";

type AskRuleOptions = {
  classifyRuleScope?: boolean;
};

type QuestionIntent = "rule" | "source_graph" | "mixed" | "general";

type QuestionClassification = {
  intent: QuestionIntent;
  reason?: string;
};

const GRAPH_EVIDENCE_EXPAND_DEPTH = 4;
const GRAPH_EVIDENCE_EXPAND_LIMIT = 300;
const GRAPH_EVIDENCE_BACKEND_LIMIT = 20;
const GRAPH_EVIDENCE_REFERENCED_TRACE_LIMIT = 80;
const GRAPH_EVIDENCE_REFERENCED_BACKEND_LIMIT = 10;

export async function askRule(query: string, options: AskRuleOptions = {}) {
  if (options.classifyRuleScope) {
    const classification = await classifyQuestionIntent(query);
    log.info("Mattermost ask classified", {
      intent: classification.intent,
      reason: classification.reason,
      queryPreview: query.slice(0, 160)
    });
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
    const fallback = classifyQuestionIntentHeuristic(query, formatClaudeFailure(result));
    log.error("Claude classifier failed; using heuristic intent fallback", {
      exitCode: result.exitCode,
      stderrPreview: preview(result.stderr),
      stdoutPreview: preview(result.stdout),
      fallbackIntent: fallback.intent
    });
    return fallback;
  }

  const parsed = parseClassifierJson(result.stdout);
  if (!parsed) {
    const fallback = classifyQuestionIntentHeuristic(query, `Invalid classifier JSON: ${preview(result.stdout)}`);
    log.error("Claude classifier returned invalid JSON; using heuristic intent fallback", {
      stdoutPreview: preview(result.stdout),
      fallbackIntent: fallback.intent
    });
    return fallback;
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
    throw new Error(formatClaudeFailure(result));
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
- For screen_traces, do not stop at rows[]. The backend evidence is under result.backend_by_java_endpoint, including exposing_methods, related_backend_nodes, related_type_details, and repository_persistence.
- If direct screen_traces are empty, inspect referenced_screen_traces. These are MCP-like follow-up traces from screens/components/scripts referenced by the original screen.
- If backend_by_java_endpoint contains handler/service/repository/table evidence, use it before saying the trace cannot continue beyond frontend/API.
- If graph evidence is insufficient, say that clearly and suggest a more specific screen/class/table/endpoint keyword.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- Include concrete graph references when available: node id, kind, project, path/source_file, line, endpoint, table, class, or method.
- Keep the answer practical and concise.
- Start with one of: "Status: found", "Status: partial", or "Status: not_found".`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(formatClaudeFailure(result));
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
- For screen_traces, do not stop at rows[]. The backend evidence is under result.backend_by_java_endpoint, including exposing_methods, related_backend_nodes, related_type_details, and repository_persistence.
- If direct screen_traces are empty, inspect referenced_screen_traces. These are MCP-like follow-up traces from screens/components/scripts referenced by the original screen.
- If backend_by_java_endpoint contains handler/service/repository/table evidence, use it before saying the trace cannot continue beyond frontend/API.
- If either rule evidence or graph evidence is insufficient, say which side is missing.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- Include concrete rule file paths/rule IDs and graph references when available.
- Keep the answer practical and concise.
- Start with one of: "Status: exists", "Status: partial", or "Status: not_found".`;

  const result = await runClaude(prompt, config.aidlcRepoPath);
  if (result.exitCode !== 0) {
    throw new Error(formatClaudeFailure(result));
  }
  return result.stdout || "(Claude returned an empty response)";
}

function collectGraphEvidence(query: string) {
  const store = new GraphStore(config.graph.sqliteDbPath);
  const candidates = extractGraphQueries(query).slice(0, 6);
  const evidence: Record<string, unknown> = {
    database: config.graph.sqliteDbPath,
    evidence_config: {
      expand_depth: GRAPH_EVIDENCE_EXPAND_DEPTH,
      expand_limit: GRAPH_EVIDENCE_EXPAND_LIMIT,
      trace_backend_limit: GRAPH_EVIDENCE_BACKEND_LIMIT,
      referenced_trace_limit: GRAPH_EVIDENCE_REFERENCED_TRACE_LIMIT,
      referenced_backend_limit: GRAPH_EVIDENCE_REFERENCED_BACKEND_LIMIT
    },
    candidates,
    graph_stats: safeGraphCall(() => store.graphStats()),
    searches: [],
    screen_traces: [],
    referenced_screen_traces: [],
    repository_persistence: [],
    method_calls_type: [],
    expansions: []
  };

  const searches = evidence.searches as unknown[];
  const screenTraces = evidence.screen_traces as unknown[];
  const referencedScreenTraces = evidence.referenced_screen_traces as unknown[];
  const repositoryPersistence = evidence.repository_persistence as unknown[];
  const methodCallsType = evidence.method_calls_type as unknown[];
  const expansions = evidence.expansions as unknown[];
  const expanded = new Set<string>();
  const tracedScreens = new Set<string>();
  log.info("Collecting graph evidence", {
    queryPreview: query.slice(0, 160),
    candidates
  });

  for (const candidate of candidates) {
    const search = safeGraphCall(() => store.searchNodes({ query: candidate, limit: 12 }));
    searches.push({ candidate, result: search });

    for (const screen of screenCandidatesFromSearch(candidate, search)) {
      traceScreenOnce(store, screenTraces, tracedScreens, screen, "matched_screen", candidate);
    }

    if (isHighSignalGraphCandidate(candidate)) {
      const nodes = selectExpansionNodes(search);
      for (const node of nodes) {
        const id = typeof node.id === "string" ? node.id : "";
        if (!id || expanded.has(id)) continue;
        expanded.add(id);
        const expansion = safeGraphCall(() =>
          store.expandNode({
            id,
            depth: GRAPH_EVIDENCE_EXPAND_DEPTH,
            direction: expansionDirection(node),
            limit: expansionLimit(node)
          })
        );
        expansions.push({
          candidate,
          id,
          result: expansion
        });

        for (const screen of referencedScreenCandidates(candidate, node, expansion)) {
          traceScreenOnce(store, referencedScreenTraces, tracedScreens, screen, "referenced_screen_or_component", id, {
            limit: GRAPH_EVIDENCE_REFERENCED_TRACE_LIMIT,
            backendLimit: GRAPH_EVIDENCE_REFERENCED_BACKEND_LIMIT
          });
        }
      }
    }

    for (const screen of screenCandidatesFromText(candidate)) {
      traceScreenOnce(store, screenTraces, tracedScreens, screen, "candidate", candidate);
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

  log.info("Graph evidence collected", summarizeGraphEvidence(evidence));
  return evidence;
}

function summarizeGraphEvidence(evidence: Record<string, unknown>) {
  const searches = evidence.searches as unknown[];
  const screenTraces = evidence.screen_traces as unknown[];
  const referencedScreenTraces = evidence.referenced_screen_traces as unknown[];
  const expansions = evidence.expansions as unknown[];
  return {
    candidates: evidence.candidates,
    searches: searches.length,
    screenTraces: screenTraces.length,
    referencedScreenTraces: referencedScreenTraces.length,
    expansions: expansions.length,
    backendTraceCount: [...screenTraces, ...referencedScreenTraces]
      .map((item) => {
        if (!item || typeof item !== "object") return 0;
        const result = (item as { result?: unknown }).result;
        if (!result || typeof result !== "object") return 0;
        const backend = (result as { backend_by_java_endpoint?: unknown }).backend_by_java_endpoint;
        return backend && typeof backend === "object" ? Object.keys(backend).length : 0;
      })
      .reduce((sum, count) => sum + count, 0)
  };
}

function extractGraphQueries(query: string) {
  const found: string[] = [];
  const add = (value?: string) => {
    const cleaned = (value ?? "").trim().replace(/^[`'"]+|[`'",.;:!?]+$/g, "");
    if (cleaned.length >= 2 && !found.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      found.push(cleaned);
    }
  };

  for (const match of query.matchAll(/\b([A-Za-z]{3,4})(\d{2,3})(?:[-_ .]?([A-Za-z]))?\b/g)) {
    const module = match[1].toLowerCase();
    const number = match[2];
    const suffix = match[3]?.toLowerCase();
    for (const screen of buildScreenCandidates(module, number, suffix)) {
      add(screen);
    }
  }

  const patterns = [
    /\b[a-z]{3,4}\/[a-z0-9_./-]+\b/gi,
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

function traceScreenOnce(
  store: GraphStore,
  target: unknown[],
  tracedScreens: Set<string>,
  screen: string,
  reason: string,
  source: string,
  options: { limit?: number; backendLimit?: number } = {}
) {
  if (!screen || tracedScreens.has(screen)) return;
  tracedScreens.add(screen);
  target.push({
    candidate: screen,
    reason,
    source,
    result: safeGraphCall(() =>
      store.traceScreen({
        screen,
        limit: options.limit ?? GRAPH_EVIDENCE_EXPAND_LIMIT,
        backend_limit: options.backendLimit ?? GRAPH_EVIDENCE_BACKEND_LIMIT
      })
    )
  });
}

function isHighSignalGraphCandidate(candidate: string) {
  return (
    candidate.includes("/") ||
    /\b[A-Z][A-Za-z0-9_]{2,}\b/.test(candidate) ||
    /\b[A-Z][A-Z0-9_]{4,}\b/.test(candidate) ||
    /\b[a-zA-Z_][\w$]*(?:CommandHandler|Handler|Repository|Finder|Service|WebService|Controller|Command|Dto|DTO|Entity|Table)\b/.test(
      candidate
    ) ||
    /\buk\.[A-Za-z0-9_.-]+\b/i.test(candidate)
  );
}

function screenCandidatesFromSearch(candidate: string, search: unknown) {
  const screens = new Set<string>(screenCandidatesFromText(candidate));
  for (const node of graphNodes(search)) {
    const kind = String(node.kind ?? "");
    if (kind !== "Screen") continue;
    for (const value of nodeTextValues(node)) {
      for (const screen of screenCandidatesFromText(value)) {
        screens.add(screen);
      }
    }
  }
  return Array.from(screens).slice(0, 8);
}

function selectExpansionNodes(search: unknown) {
  return graphNodes(search)
    .filter((node) => typeof node.id === "string")
    .sort((a, b) => expansionPriority(a) - expansionPriority(b))
    .slice(0, 3);
}

function expansionPriority(node: Record<string, unknown>) {
  const priorities: Record<string, number> = {
    Screen: 0,
    Endpoint: 1,
    ApiConstant: 2,
    JavaType: 3,
    Method: 4,
    Repository: 5,
    Entity: 6,
    Table: 7,
    Script: 8,
    File: 9,
    Binding: 10
  };
  return priorities[String(node.kind ?? "")] ?? 20;
}

function expansionDirection(node: Record<string, unknown>) {
  const kind = String(node.kind ?? "");
  if (["Screen", "Script", "ScriptRef", "StyleRef", "File", "Binding", "UIControl", "Template"].includes(kind)) {
    return "out";
  }
  return "both";
}

function expansionLimit(node: Record<string, unknown>) {
  const kind = String(node.kind ?? "");
  if (kind === "Screen") return 140;
  if (["Script", "File", "Binding"].includes(kind)) return 100;
  return GRAPH_EVIDENCE_EXPAND_LIMIT;
}

function referencedScreenCandidates(candidate: string, rootNode: Record<string, unknown>, expansion: unknown) {
  const screens = new Set<string>();
  const base = parseScreenCandidate(screenCandidatesFromText(candidate)[0] ?? candidate);
  const nodes = graphNodes(expansion);

  for (const node of [rootNode, ...nodes]) {
    for (const value of nodeTextValues(node)) {
      for (const screen of screenCandidatesFromText(value)) {
        screens.add(screen);
      }
      for (const screen of relativeScreenCandidates(value, base)) {
        screens.add(screen);
      }
    }
  }

  return Array.from(screens)
    .filter((screen) => screen !== candidate)
    .sort((a, b) => referencedScreenPriority(a, candidate) - referencedScreenPriority(b, candidate))
    .slice(0, 6);
}

function referencedScreenPriority(screen: string, sourceCandidate: string) {
  const source = parseScreenCandidate(screenCandidatesFromText(sourceCandidate)[0] ?? sourceCandidate);
  const current = parseScreenCandidate(screen);
  if (!source || !current) return 20;
  if (current.module === source.module && current.number === source.number && screen.includes("/common")) return 0;
  if (current.module === source.module && screen.includes("/common")) return 1;
  if (current.module === source.module) return 2;
  if (screen.includes("category-handlers")) return 3;
  if (screen.includes("/common")) return 4;
  return 10;
}

function nodeTextValues(node: Record<string, unknown>) {
  return ["key", "name", "path", "source_file", "normalized_path"]
    .map((field) => node[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function screenCandidatesFromText(value: string) {
  const screens = new Set<string>();
  const text = value.replace(/\\/g, "/");

  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]{3,4})\/(\d{2,3})(?:\/([A-Za-z0-9_-]+))?/g)) {
    for (const screen of buildScreenCandidates(match[1], match[2], match[3])) {
      screens.add(screen);
    }
  }

  for (const match of text.matchAll(/\b([A-Za-z]{3,4})(\d{2,3})(?:[-_ .]?([A-Za-z]))?\b/g)) {
    for (const screen of buildScreenCandidates(match[1], match[2], match[3])) {
      screens.add(screen);
    }
  }

  return Array.from(screens);
}

function relativeScreenCandidates(value: string, base: { module: string; number: string } | null) {
  if (!base) return [];
  const screens = new Set<string>();
  const text = value.replace(/\\/g, "/");
  if (!text.includes("../") && !text.includes("./")) return [];

  const relativeMatch = text.match(/(?:^|\/)(\d{2,3})\/([A-Za-z0-9_-]+)/);
  if (relativeMatch) {
    for (const screen of buildScreenCandidates(base.module, relativeMatch[1], relativeMatch[2])) {
      screens.add(screen);
    }
  }

  if (/(?:^|\/)common(?:\/|$)/i.test(text)) {
    screens.add(`${base.module}/${base.number}/common`);
  }

  return Array.from(screens);
}

function parseScreenCandidate(value: string) {
  const match = value.match(/^([a-z]{3,4})\/(\d{2,3})(?:\/[a-z0-9_-]+)?$/i);
  if (!match) return null;
  return {
    module: match[1].toLowerCase(),
    number: match[2].length === 2 ? match[2].padStart(3, "0") : match[2]
  };
}

function buildScreenCandidates(moduleValue: string, numberValue: string, suffixValue?: string) {
  const module = moduleValue.toLowerCase();
  const number = numberValue.length === 2 ? numberValue.padStart(3, "0") : numberValue;
  const rawNumber = numberValue;
  const suffix = suffixValue?.toLowerCase();
  const screens = new Set<string>();

  if (suffix) screens.add(`${module}/${number}/${suffix}`);
  screens.add(`${module}/${number}`);

  if (rawNumber !== number) {
    if (suffix) screens.add(`${module}/${rawNumber}/${suffix}`);
    screens.add(`${module}/${rawNumber}`);
  }

  return Array.from(screens);
}

function isQuestionIntent(value: unknown): value is QuestionIntent {
  return value === "rule" || value === "source_graph" || value === "mixed" || value === "general";
}

function classifyQuestionIntentHeuristic(query: string, detail: string): QuestionClassification {
  const sourcePatterns = [
    /\b[A-Za-z]{3}\d{3}(?:[-_ ]?[A-Za-z])?\b/,
    /\b[a-z]{2,}\/[a-z0-9_./-]+\b/i,
    /\b[A-Z][A-Za-z0-9_]*(?:CommandHandler|Handler|Repository|Finder|Service|WebService|Controller|Command|Dto|DTO|Entity|Table)\b/,
    /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/,
    /\buk\.[A-Za-z0-9_.-]+\b/i,
    /\b(endpoint|repository|service|domain|frontend|backend|screen|component|class|method|table|database|db|sql|trace|flow)\b/i,
    /(màn hình|man hinh|luồng|luong|nghiệp vụ|nghiep vu|bảng|bang|dữ liệu|du lieu|ảnh hưởng|anh huong|lưu|luu|xử lý|xu ly)/i
  ];
  const rulePatterns = [
    /\b(rule|aidlc|definition of done|done|process|playbook|resiliency|testing|test|checksheet|guideline)\b/i,
    /(quy định|quy dinh|luật|luat|tiêu chuẩn|tieu chuan|bắt buộc|bat buoc|quy trình|quy trinh)/i,
    /\b[A-Z]+-\d{2,}\b/
  ];

  const needsSource = sourcePatterns.some((pattern) => pattern.test(query));
  const needsRule = rulePatterns.some((pattern) => pattern.test(query));
  const reason = `Heuristic fallback because Claude classifier failed. ${detail}`;

  if (needsRule && needsSource) return { intent: "mixed", reason };
  if (needsSource) return { intent: "source_graph", reason };
  if (needsRule) return { intent: "rule", reason };
  return { intent: "general", reason };
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
    throw new Error(formatClaudeFailure(result));
  }
  return result.stdout || "(Claude returned an empty response)";
}

function formatClaudeFailure(result: ClaudeResult) {
  const detail = result.stderr || result.stdout;
  if (!detail) return `Claude exited with code ${result.exitCode}`;
  return `Claude exited with code ${result.exitCode}: ${preview(detail, 1200)}`;
}

function preview(value: string, maxLength = 600) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}
