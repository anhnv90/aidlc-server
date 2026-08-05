export type MattermostAttachment = {
  fallback: string;
  color: string;
  title: string;
  text: string;
};

export function formatAttachment(message: string): MattermostAttachment {
  return {
    fallback: attachmentFallback(message),
    color: attachmentColor(message),
    title: attachmentTitle(message),
    text: message
  };
}

function attachmentFallback(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact || "AI-DLC Bot response";
}

function attachmentTitle(message: string) {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^received .* queued as job #\d+/i.test(firstLine)) return "AI-DLC Job Queued";
  if (/^response for job #\d+/i.test(firstLine)) return "AI-DLC Job Response";
  if (/status:\s*not_applicable/i.test(message)) return "AI-DLC Ask Not Applicable";
  if (/^status:/i.test(firstLine)) return "AI-DLC Rule Search";
  if (/created rule update pr/i.test(message)) return "AI-DLC Rule Update Completed";
  if (/failed/i.test(firstLine)) return "AI-DLC Error";
  if (/not authorized/i.test(firstLine)) return "AI-DLC Rule Update Rejected";
  if (/supported commands/i.test(message) || /missing required field/i.test(firstLine)) return "AI-DLC Bot Help";
  return "AI-DLC Bot";
}

function attachmentColor(message: string) {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const statusLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^status:/i.test(line));

  if (/failed|not authorized|rejected/i.test(firstLine)) return "#d92d20";
  if (/^status:\s*not_found\b/i.test(statusLine ?? "")) return "#d92d20";
  if (/^status:\s*(found|exists)\b/i.test(statusLine ?? "") || /created rule update pr/i.test(firstLine)) return "#12b76a";
  if (/^status:\s*partial\b/i.test(statusLine ?? "")) return "#f79009";
  if (/^status:\s*not_applicable\b/i.test(statusLine ?? "")) return "#667085";
  if (/^received .* queued as job #\d+/i.test(firstLine)) return "#2e90fa";
  return "#2e90fa";
}
