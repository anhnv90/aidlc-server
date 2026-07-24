import { config } from "../config";
import { runClaude } from "../claude/runner";
import { searchRuleRepo } from "./repoSearch";

type AskRuleOptions = {
  classifyRuleScope?: boolean;
};

type RuleQuestionClassification = {
  ruleRelated: boolean;
  response: string;
};

export async function askRule(query: string, options: AskRuleOptions = {}) {
  if (options.classifyRuleScope) {
    const classification = await classifyRuleQuestion(query);
    if (!classification.ruleRelated) {
      return classification.response;
    }
  }

  if (config.claude.searchMode === "agent") {
    return askRuleWithAgent(query);
  }

  const hits = searchRuleRepo(query);
  if (hits.length === 0) {
    return answerNoSearchHits(query);
  }

  const context = hits
    .map(
      (hit, index) => `SOURCE ${index + 1}
File: ${hit.file}
Score: ${hit.score}
Snippet:
${hit.snippet}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are the AI-DLC Rule Search Agent.

Task:
Answer the user's natural-language question directly using ONLY the provided repository search results.
Do not ask what the user wants to do.
Do not mention the current git branch unless it is directly relevant to the answer.

Question:
${query}

Repository search results:
${context}

Answer rules:
- Do not search Mattermost history.
- Do not use external web sources.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- If the response language is ambiguous, answer in English.
- Keep the required status prefix exactly in English.
- Start with one of: "Status: exists", "Status: partial", or "Status: not_found".
- Include concrete source file paths from the provided search results.
- Classify the result as one of: exists, partial, not_found.
- If the rule only partially exists, explain what is missing.
- Keep the answer short and practical.
`;

  const result = await runClaude(prompt, config.aidlcRepoPath);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}

async function classifyRuleQuestion(query: string): Promise<RuleQuestionClassification> {
  const prompt = `You are the AI-DLC Rule Search Intent Classifier.

The user mentioned @claude in Mattermost with this message:
${query}

Task:
Decide whether this message should search the AI-DLC rule repository.

Classify as rule_related=true when the user is asking about:
- AI-DLC rules, process, playbook, Definition of Done, testing rules, development lifecycle, reverse engineering, design/detailing rules, source restrictions, PR/checksheet requirements.
- Whether a rule exists, where a rule is located, or how a project should follow AI-DLC rules.

Classify as rule_related=false when the message is a greeting, a general chat message, a server operation request, a Mattermost usage question, a general programming question, or anything that does not require reading AI-DLC rule files.

Rules:
- Do not inspect local files.
- Do not search the web.
- Read the full user message before choosing the response language.
- If the user explicitly asks for a response language, use that language for non_rule_response.
- If no response language is requested, use the main language of the user's message for non_rule_response.
- If the response language is ambiguous, use English.
- Output JSON only, with this exact shape:
{
  "rule_related": true,
  "non_rule_response": "Status: not_applicable\\n\\n..."
}

When rule_related=false, non_rule_response must start with exactly "Status: not_applicable" and should briefly say that the question is outside AI-DLC rule search scope, so the rule repository was not searched.
When rule_related=true, non_rule_response can be an empty string.`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }

  const parsed = parseClassifierJson(result.stdout);
  if (!parsed) {
    throw new Error(`Claude classifier returned invalid JSON: ${result.stdout || "(empty response)"}`);
  }

  return {
    ruleRelated: parsed.rule_related,
    response:
      parsed.non_rule_response ||
      "Status: not_applicable\n\nThis question is outside AI-DLC rule search scope, so the rule repository was not searched."
  };
}

function parseClassifierJson(value: string) {
  const compact = value.trim();
  const jsonText = compact.match(/\{[\s\S]*\}/)?.[0] ?? compact;
  try {
    const parsed = JSON.parse(jsonText) as {
      rule_related?: unknown;
      non_rule_response?: unknown;
    };
    if (typeof parsed.rule_related !== "boolean") return null;
    return {
      rule_related: parsed.rule_related,
      non_rule_response: typeof parsed.non_rule_response === "string" ? parsed.non_rule_response.trim() : ""
    };
  } catch {
    return null;
  }
}

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

async function answerNoSearchHits(query: string) {
  const prompt = `You are the AI-DLC Rule Search Agent.

The repository text search returned no related rule results for this Mattermost question:
${query}

Task:
Answer directly that no related rule was found in the AI-DLC repository.

Answer rules:
- Do not search Mattermost history.
- Do not use external web sources.
- Read the full user question before choosing the response language.
- If the user explicitly asks for a response language, answer in that requested language.
- If no response language is requested, answer in the main language of the user's question.
- If the response language is ambiguous, answer in English.
- Keep the required status prefix exactly in English.
- Start with exactly: "Status: not_found".
- Keep the answer short and practical.`;

  const result = await runClaude(prompt, config.aidlcRepoPath);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }
  return result.stdout || "(Claude returned an empty response)";
}
