import { config } from "../config";
import { runClaude } from "../claude/runner";

type AskRuleOptions = {
  classifyRuleScope?: boolean;
};

type RuleQuestionClassification = {
  ruleRelated: boolean;
};

export async function askRule(query: string, options: AskRuleOptions = {}) {
  if (options.classifyRuleScope) {
    const classification = await classifyRuleQuestion(query);
    if (!classification.ruleRelated) {
      return answerGeneralQuestion(query);
    }
  }

  return askRuleWithAgent(query);
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
  "rule_related": true
}

Do not answer the user's question in this classifier response. Only classify whether the AI-DLC rule repository is needed.`;

  const result = await runClaude(prompt, process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Claude exited with code ${result.exitCode}`);
  }

  const parsed = parseClassifierJson(result.stdout);
  if (!parsed) {
    throw new Error(`Claude classifier returned invalid JSON: ${result.stdout || "(empty response)"}`);
  }

  return {
    ruleRelated: parsed.rule_related
  };
}

function parseClassifierJson(value: string) {
  const compact = value.trim();
  const jsonText = compact.match(/\{[\s\S]*\}/)?.[0] ?? compact;
  try {
    const parsed = JSON.parse(jsonText) as {
      rule_related?: unknown;
    };
    if (typeof parsed.rule_related !== "boolean") return null;
    return {
      rule_related: parsed.rule_related
    };
  } catch {
    return null;
  }
}

async function answerGeneralQuestion(query: string) {
  const prompt = `You are Claude responding to a Mattermost mention.

The user mentioned @claude with this message:
${query}

The message was classified as NOT requiring AI-DLC rule repository search.

Task:
Answer the user's question directly as a general assistant.

Rules:
- Do not search the AI-DLC rule repository.
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
