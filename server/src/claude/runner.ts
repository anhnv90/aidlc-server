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

    const timeout = setTimeout(() => {
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

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (exitCode) => {
      completed = true;
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
    });
  });
}

function fakeClaudeResponse(prompt: string) {
  if (prompt.includes("AI-DLC Rule Search Intent Classifier")) {
    return JSON.stringify({
      rule_related: !/weather|server|maintenance|hello|offline/i.test(prompt),
      non_rule_response:
        "Status: not_applicable\n\nFake classifier decided this question is outside AI-DLC rule search scope, so the rule repository was not searched."
    });
  }

  if (prompt.includes("Rule Search Agent")) {
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
