import { spawn } from "node:child_process";
import { config } from "../config";
import { log } from "../log";

export type ClaudeResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export async function runClaude(prompt: string, cwd: string): Promise<ClaudeResult> {
  if (config.claude.fakeMode) {
    log.info("Claude fake mode response generated");
    return {
      stdout: fakeClaudeResponse(prompt),
      stderr: "",
      exitCode: 0
    };
  }

  const args = [...config.claude.extraArgs, "--input-format", "text", "-p"];
  log.info("Running Claude", { command: config.claude.command, cwd, timeoutMs: config.claude.timeoutMs });

  return new Promise((resolve) => {
    const child = spawn(config.claude.command, args, {
      cwd,
      shell: true,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let completed = false;
    let timeout: NodeJS.Timeout;

    const finish = (exitCode: number | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
    };

    timeout = setTimeout(() => {
      if (completed) return;
      stderr += `\nClaude timed out after ${config.claude.timeoutMs}ms`;
      child.kill("SIGTERM");
    }, config.claude.timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.on("error", (err) => {
      stderr += `\nClaude stdin error: ${err.message}`;
    });

    child.on("error", (err) => {
      stderr += `\nClaude process error: ${err.message}`;
      finish(1);
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (exitCode) => {
      finish(exitCode);
    });
  });
}

function fakeClaudeResponse(prompt: string) {
  if (prompt.includes("AI-DLC Mattermost Question Intent Classifier")) {
    const userMessage = extractPromptBlock(prompt, "The user mentioned @claude in Mattermost with this message:", "Task:");
    if (/done|rule|process|playbook|definition|resiliency|aidlc/i.test(userMessage) && /screen|source|class|repository|endpoint|table|flow|JAM|CommandHandler/i.test(userMessage)) {
      return JSON.stringify({ intent: "mixed", reason: "fake mixed rule and source graph question" });
    }
    if (/screen|source|class|repository|endpoint|table|flow|JAM|CommandHandler|JRQMT|Remand/i.test(userMessage)) {
      return JSON.stringify({ intent: "source_graph", reason: "fake source graph question" });
    }
    if (/rule|process|playbook|definition|resiliency|aidlc/i.test(userMessage)) {
      return JSON.stringify({ intent: "rule", reason: "fake rule question" });
    }
    return JSON.stringify({ intent: "general", reason: "fake general question" });
  }

  if (prompt.includes("AI-DLC Rule Search Intent Classifier")) {
    const userMessage = extractPromptBlock(prompt, "The user mentioned @claude in Mattermost with this message:", "Task:");
    return JSON.stringify({
      rule_related: !/weather|server|maintenance|hello|offline/i.test(userMessage)
    });
  }

  if (prompt.includes("responding to a Mattermost mention")) {
    return "Fake general assistant response: this question was classified as outside AI-DLC rule search, so Claude answered it directly.";
  }

  if (prompt.includes("using the AIDLC business/source graph")) {
    return [
      "Status: partial",
      "Summary: Fake mode routed this question to the source graph and found sample graph evidence.",
      "Sources:",
      "- graph.sqlite search_nodes",
      "- graph.sqlite expand_node",
      "Recommendation: disable CLAUDE_FAKE_MODE to answer from real graph evidence."
    ].join("\n");
  }

  if (prompt.includes("Graph evidence from SQLite") && prompt.includes("AI-DLC rule repository knowledge")) {
    return [
      "Status: partial",
      "Summary: Fake mode routed this as a mixed rule/source question.",
      "Sources:",
      "- aidlc-rules/",
      "- graph.sqlite",
      "Recommendation: disable CLAUDE_FAKE_MODE for real rule and graph evidence."
    ].join("\n");
  }

  if (prompt.includes("Rule Search Agent") || prompt.includes("Claude Code running inside the AI-DLC repository")) {
    return [
      "Status: partial",
      "Summary: Fake mode found related Build and Test / NP-TST rules, but no strict browser-based Done gate.",
      "Sources:",
      "- aidlc-rules/.aidlc-rule-details/construction/build-and-test.md",
      "- aidlc-rules/.aidlc-rule-details/new-process/testing.md",
      "Recommendation: add a browser/device user-journey Definition of Done rule if this is required."
    ].join("\n");
  }

  return [
    "Fake Claude update completed.",
    "No files were changed because CLAUDE_FAKE_MODE=true."
  ].join("\n");
}

function extractPromptBlock(prompt: string, startMarker: string, endMarker: string) {
  const start = prompt.indexOf(startMarker);
  if (start < 0) return prompt;
  const contentStart = start + startMarker.length;
  const end = prompt.indexOf(endMarker, contentStart);
  return prompt.slice(contentStart, end < 0 ? undefined : end).trim();
}
