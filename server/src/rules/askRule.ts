import { config } from "../config";
import { runClaude } from "../claude/runner";
import { searchRuleRepo } from "./repoSearch";

export async function askRule(query: string) {
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
