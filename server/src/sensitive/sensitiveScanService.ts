import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

type JobStatus = "queued" | "running" | "completed" | "failed";
type SensitiveOperation = "scan" | "mask";
type Severity = "high" | "medium" | "low";

type ChangedFileSnapshot = {
  status: string;
  file: string;
  raw: string;
};

type ProjectInput = {
  name?: string;
  label?: string;
  path?: string;
  selected?: boolean;
};

type ProjectSnapshot = {
  name: string;
  label: string;
  path: string;
  exists: boolean;
  selected: boolean;
};

type ProjectResult = {
  name: string;
  path: string;
  scannedFiles: number;
  findings: number;
  changedFiles: number;
};

type SensitiveJobResult = {
  rootPath?: string;
  projects?: ProjectResult[];
  scannedFiles?: number;
  changedFiles?: number;
  changedFileList?: ChangedFileSnapshot[];
  findings?: SensitiveFindingSnapshot[];
  summary?: SensitiveSummary;
};

type SensitiveSummary = {
  total: number;
  high: number;
  medium: number;
  low: number;
  files: number;
  maskable: number;
};

export type SensitiveFindingSnapshot = {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  group: string;
  file: string;
  line: number;
  key: string;
  preview: string;
  redactedValue: string;
  confidence: number;
  maskable: boolean;
};

type FileScanResult = {
  findings: SensitiveFindingSnapshot[];
  changed: boolean;
};

type TextTransformResult = {
  text: string;
  findings: SensitiveFindingSnapshot[];
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const JOB_START_DELAY_MS = 25;
const DISCOVER_PROGRESS_INTERVAL = 1000;
const DISCOVER_YIELD_INTERVAL = 250;
const FILE_SCAN_YIELD_INTERVAL = 100;
const MASK_VALUE = "__MASKED_SECRET__";
const WHOLE_FILE_MASK_TEXT = "REDACTED: sensitive license/credential file removed for AI-safe source snapshot.\n";

const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".gradle",
  ".secret-masker",
  ".sensitive-scan",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "logs",
  "tmp",
  "temp"
]);

const HARD_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".gradle",
  ".secret-masker",
  ".sensitive-scan",
  "node_modules",
  "coverage",
  "logs",
  "tmp",
  "temp"
]);

const WHOLE_FILE_MASK_EXTENSIONS = new Set([
  ".cer",
  ".crt",
  ".jks",
  ".key",
  ".keystore",
  ".lic",
  ".license",
  ".p12",
  ".pem",
  ".pfx"
]);

const TEXT_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cmd",
  ".conf",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".gradle",
  ".graphql",
  ".groovy",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".md",
  ".mjs",
  ".php",
  ".properties",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const TEXT_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "dockerfile",
  "jenkinsfile",
  "makefile"
]);

const SOURCE_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cmd",
  ".cpp",
  ".cs",
  ".go",
  ".groovy",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue"
]);

const SENSITIVE_KEY_FRAGMENT =
  "(?:password|passwd|pwd|secret|credential|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|personal[_-]?access[_-]?token|api[_-]?key|apikey|client[_-]?secret|app[_-]?secret|consumer[_-]?secret|signing[_-]?secret|jwt[_-]?secret|webhook[_-]?secret|private[_-]?key|encryption[_-]?key|decrypt[_-]?key|master[_-]?key|license[_-]?key|activation[_-]?key|github[_-]?token|gitlab[_-]?token|npm[_-]?token|docker[_-]?password|registry[_-]?password|authorization)";
const CONNECTION_KEY_FRAGMENT =
  "(?:url|uri|database[_-]?url|data[_-]?source[_.-]?url|datasource[_.-]?url|connection[_-]?string|conn[_-]?string|jdbc[_-]?url|mongo(?:db)?[_-]?uri|redis[_-]?url|postgres[_-]?url|mysql[_-]?url|sqlserver[_-]?url|oracle[_-]?url|dsn)";
const JSON_VALUE_PATTERN = new RegExp(`("([^"\\r\\n]*${SENSITIVE_KEY_FRAGMENT}[^"\\r\\n]*)"\\s*:\\s*")([^"\\r\\n]*?)(")`, "gi");
const JSON_CONNECTION_VALUE_PATTERN = new RegExp(`("([^"\\r\\n]*${CONNECTION_KEY_FRAGMENT}[^"\\r\\n]*)"\\s*:\\s*")([^"\\r\\n]*?)(")`, "gi");
const XML_VALUE_PATTERN = new RegExp(`(<([A-Za-z0-9_.:-]*${SENSITIVE_KEY_FRAGMENT}[A-Za-z0-9_.:-]*)\\b[^>]*>)([^<]{1,4096})(<\\/\\2>)`, "gi");
const XML_CONNECTION_VALUE_PATTERN = new RegExp(`(<([A-Za-z0-9_.:-]*${CONNECTION_KEY_FRAGMENT}[A-Za-z0-9_.:-]*)\\b[^>]*>)([^<]{1,4096})(<\\/\\2>)`, "gi");
const KEY_VALUE_PATTERN = new RegExp(
  `^([ \\t]*([A-Za-z0-9_.-]*${SENSITIVE_KEY_FRAGMENT}[A-Za-z0-9_.-]*)[ \\t]*(?::|=(?!=))[ \\t]*)(["']?)([^\\r\\n#;]*?)(\\3)([ \\t]*(?:[#;].*)?)$`,
  "gim"
);
const CONNECTION_KEY_VALUE_PATTERN = new RegExp(
  `^([ \\t]*([A-Za-z0-9_.-]*${CONNECTION_KEY_FRAGMENT}[A-Za-z0-9_.-]*)[ \\t]*(?::|=(?!=))[ \\t]*)(["']?)([^\\r\\n#]*?)(\\3)([ \\t]*(?:#.*)?)$`,
  "gim"
);
const SOURCE_ASSIGNMENT_PATTERN =
  /(\b[A-Za-z_$][\w$]*\b\s*(?:=|:)\s*)(["'`])([^"'`\r\n]*)(\2)/gi;
const AUTH_HEADER_PATTERN = /(\b(?:setRequestProperty|setHeader|header)\s*\(\s*["']Authorization["']\s*,\s*["'])([^"'`\r\n]+)(["'])/gi;
const CONNECTION_STRING_PATTERN =
  /(["'`])((?:jdbc:[^"'`\r\n]+|mongodb(?:\+srv)?:\/\/[^"'`\r\n]+|redis:\/\/[^"'`\r\n]+|amqps?:\/\/[^"'`\r\n]+|postgres(?:ql)?:\/\/[^"'`\r\n]+|mysql:\/\/[^"'`\r\n]+|sqlserver:[^"'`\r\n]+|oracle:thin:[^"'`\r\n]+))(\1)/gi;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ASPOSE_LICENSE_VALUE_PATTERN = /(<(?:Data|Signature)>)([^<]{20,})(<\/(?:Data|Signature)>)/gi;

const TOKEN_PATTERNS = [
  { ruleId: "aws-access-key", ruleName: "AWS access key", regex: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g },
  { ruleId: "github-token", ruleName: "GitHub token", regex: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g },
  { ruleId: "openai-key", ruleName: "OpenAI API key", regex: /\b(sk-[A-Za-z0-9_-]{20,})\b/g },
  { ruleId: "slack-token", ruleName: "Slack token", regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { ruleId: "stripe-secret-key", ruleName: "Stripe secret key", regex: /\b(sk_(?:live|test)_[A-Za-z0-9]{16,})\b/g },
  { ruleId: "jwt-token", ruleName: "JWT token", regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g }
];

class SensitiveJob {
  readonly id = randomUUID();
  readonly operation: SensitiveOperation;
  status: JobStatus = "queued";
  startedAt: string | null = null;
  finishedAt: string | null = null;
  lines: string[] = [];
  currentFile: string | null = null;
  scannedFiles = 0;
  totalFiles = 0;
  result: SensitiveJobResult | null = null;
  error: string | null = null;

  constructor(readonly payload: Record<string, unknown>, operation: SensitiveOperation) {
    this.operation = operation;
  }

  append(line: unknown) {
    const value = String(line).trimEnd();
    if (!value) return;
    this.lines.push(value);
    this.lines = this.lines.slice(-5000);
  }

  snapshot() {
    return {
      id: this.id,
      operation: this.operation,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      currentFile: this.currentFile,
      scannedFiles: this.scannedFiles,
      totalFiles: this.totalFiles,
      lines: this.lines.slice(-500),
      result: this.result,
      error: this.error
    };
  }
}

export class SensitiveScanService {
  private readonly jobs = new Map<string, SensitiveJob>();

  startScan(payload: unknown) {
    return this.startJob(payload, "scan");
  }

  startMask(payload: unknown) {
    return this.startJob(payload, "mask");
  }

  getJob(jobId: string) {
    return this.jobs.get(jobId)?.snapshot() ?? null;
  }

  defaultPayload() {
    const defaultRoot = resolve("..");
    return {
      defaultExcludes: Array.from(DEFAULT_EXCLUDES),
      projectRoots: [{ path: defaultRoot }],
      projects: this.discoverProjects({ projectRoots: [{ path: defaultRoot }] }).projects
    };
  }

  discoverProjects(payload: unknown) {
    const roots = this.projectRootsFromPayload(payload);
    const projects: ProjectSnapshot[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      this.addProjectIfUseful(projects, seen, root, true);
      for (const entry of safeReadDir(root)) {
        if (!entry.isDirectory()) continue;
        if (DEFAULT_EXCLUDES.has(entry.name.toLowerCase())) continue;
        this.addProjectIfUseful(projects, seen, join(root, entry.name), true);
      }
    }

    return {
      projectRoots: roots.map((path) => ({ path })),
      projects
    };
  }

  browsePath(rawPath: string) {
    if (!rawPath) {
      return { path: "", parent: null, entries: listDrives(), exists: true };
    }

    let path = decodeURIComponent(rawPath);
    if (!existsSync(path)) {
      const parent = dirname(path);
      return {
        path,
        parent: parent && parent !== path ? parent : null,
        entries: [],
        exists: false
      };
    }

    path = resolve(path);
    const stat = statSync(path);
    if (!stat.isDirectory()) path = dirname(path);
    const parent = dirname(path);
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        is_dir: true
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      path,
      parent: parent && parent !== path ? parent : null,
      entries,
      exists: true
    };
  }

  private startJob(payload: unknown, operation: SensitiveOperation) {
    const data = isRecord(payload) ? payload : {};
    const job = new SensitiveJob(data, operation);
    this.jobs.set(job.id, job);
    setTimeout(() => {
      void this.runJob(job);
    }, JOB_START_DELAY_MS);
    return { jobId: job.id, status: job.status };
  }

  private async runJob(job: SensitiveJob) {
    job.status = "running";
    job.startedAt = timestamp();

    try {
      job.result = await this.scanOrMaskProjects(job, job.operation === "mask");
      job.status = "completed";
      job.finishedAt = timestamp();
      job.append(`[done] ${job.operation} completed.`);
    } catch (err) {
      job.status = "failed";
      job.finishedAt = timestamp();
      job.error = errorMessage(err);
      job.append(`[error] ${job.error}`);
    }
  }

  private async scanOrMaskProjects(job: SensitiveJob, shouldMask: boolean): Promise<SensitiveJobResult> {
    const projects = this.selectedProjectsFromPayload(job.payload);
    if (projects.length === 0) throw new Error("Select at least one project.");

    const allFindings: SensitiveFindingSnapshot[] = [];
    const changedFileList: ChangedFileSnapshot[] = [];
    const projectResults: ProjectResult[] = [];
    let scannedFiles = 0;
    let totalFiles = 0;

    for (const project of projects) {
      job.append(`[project] ${project.label} -> ${project.path}`);
      const files = await this.collectCandidateFiles(project.path, job);
      totalFiles += files.length;
      job.totalFiles = totalFiles;

      const projectStartFindings = allFindings.length;
      const projectStartChanged = changedFileList.length;
      let projectScanned = 0;

      for (const filePath of files) {
        scannedFiles += 1;
        projectScanned += 1;
        job.scannedFiles = scannedFiles;
        job.currentFile = relativePath(project.path, filePath);
        if (scannedFiles % 50 === 0 || scannedFiles === 1) {
          job.append(`[${job.operation}] ${scannedFiles}/${job.totalFiles} ${project.label}/${job.currentFile}`);
        }

        const result = scanSensitiveFile(project.path, filePath, shouldMask);
        allFindings.push(...result.findings);
        if (result.changed) {
          const file = relativePath(project.path, filePath);
          changedFileList.push({ status: "M", file: `${project.label}/${file}`, raw: `M ${file}` });
        }

        if (scannedFiles % FILE_SCAN_YIELD_INTERVAL === 0) {
          await delay(0);
        }
      }

      const projectFindings = allFindings.length - projectStartFindings;
      const projectChanged = changedFileList.length - projectStartChanged;
      projectResults.push({
        name: project.label,
        path: project.path,
        scannedFiles: projectScanned,
        findings: projectFindings,
        changedFiles: projectChanged
      });
      job.append(`[project-summary] ${project.label}: scanned=${projectScanned}, findings=${projectFindings}, changed=${projectChanged}`);
    }

    const summary = summarize(allFindings);
    job.append(`[summary] projects=${projects.length}, scanned_files=${scannedFiles}, findings=${summary.total}, changed_files=${changedFileList.length}`);
    for (const changedFile of changedFileList.slice(0, 200)) {
      job.append(`[changed] ${changedFile.status} ${changedFile.file}`);
    }
    if (changedFileList.length > 200) {
      job.append(`[changed] showing first 200 of ${changedFileList.length} changed file(s)`);
    }

    return {
      rootPath: projects.length === 1 ? projects[0].path : undefined,
      projects: projectResults,
      scannedFiles,
      changedFiles: changedFileList.length,
      changedFileList,
      findings: allFindings,
      summary
    };
  }

  private async collectCandidateFiles(rootPath: string, job: SensitiveJob) {
    const files: string[] = [];
    const extraExcludes = new Set(arrayOfStrings(job.payload.excludeDirs).map((value) => value.toLowerCase()));
    const stack: Array<{ dir: string; normalExcluded: boolean }> = [{ dir: rootPath, normalExcluded: false }];
    let visitedEntries = 0;

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;

      let entries: Dirent<string>[];
      try {
        entries = readdirSync(item.dir, { withFileTypes: true });
      } catch (err) {
        job.append(`[skip] ${relativePath(rootPath, item.dir)} (${errorMessage(err)})`);
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(item.dir, entry.name);
        const lowerName = entry.name.toLowerCase();
        visitedEntries += 1;

        if (visitedEntries % DISCOVER_PROGRESS_INTERVAL === 0) {
          job.currentFile = relativePath(rootPath, fullPath);
          job.append(`[discover] visited=${visitedEntries}, files=${files.length}, current=${job.currentFile}`);
        }
        if (visitedEntries % DISCOVER_YIELD_INTERVAL === 0) {
          await delay(0);
        }

        if (entry.isDirectory()) {
          if (HARD_EXCLUDES.has(lowerName)) continue;
          const normalExcluded = item.normalExcluded || DEFAULT_EXCLUDES.has(lowerName) || extraExcludes.has(lowerName);
          stack.push({ dir: fullPath, normalExcluded });
          continue;
        }

        if (!entry.isFile()) continue;
        if (isWholeFileMaskFile(fullPath)) {
          files.push(fullPath);
          continue;
        }
        if (item.normalExcluded) continue;
        if (!isTextFile(fullPath)) continue;

        try {
          const stat = statSync(fullPath);
          if (stat.size > MAX_FILE_BYTES) {
            job.append(`[skip-large] ${relativePath(rootPath, fullPath)} (${stat.size} bytes)`);
            continue;
          }
        } catch {
          continue;
        }
        files.push(fullPath);
      }
    }

    files.sort((a, b) => a.localeCompare(b));
    job.append(`[discover] ${files.length} candidate file(s) under ${rootPath}`);
    return files;
  }

  private addProjectIfUseful(projects: ProjectSnapshot[], seen: Set<string>, path: string, selected: boolean) {
    const resolved = resolve(path);
    if (seen.has(resolved.toLowerCase())) return;
    const exists = existsSync(resolved) && statSync(resolved).isDirectory();
    if (!exists) return;
    if (!looksLikeSourceProject(resolved)) return;
    seen.add(resolved.toLowerCase());
    const name = basename(resolved) || resolved;
    projects.push({ name, label: name, path: resolved, exists, selected });
  }

  private selectedProjectsFromPayload(payload: Record<string, unknown>) {
    const projects = projectInputsFromPayload(payload)
      .filter((project) => project.selected !== false)
      .map((project) => {
        const path = requireDirectory(stringValue(project.path), "projectPath");
        const label = stringValue(project.label) || stringValue(project.name) || basename(path) || path;
        return { label, path };
      });

    if (projects.length > 0) return projects;

    const fallback = stringValue(payload.rootPath || payload.repoPath || payload.targetPath || payload.path);
    if (!fallback) return [];
    const path = requireDirectory(fallback, "rootPath");
    return [{ label: basename(path) || path, path }];
  }

  private projectRootsFromPayload(payload: unknown) {
    const data = isRecord(payload) ? payload : {};
    const roots = arrayOfStrings(data.projectRoots)
      .map((value) => (isRecord(value) ? stringValue(value.path) : String(value)))
      .filter(Boolean);
    const fallback = stringValue(data.rootPath || data.repoPath || data.targetPath || data.path);
    if (fallback) roots.push(fallback);
    const normalized = roots.length > 0 ? roots : [resolve("..")];
    return Array.from(new Set(normalized.map((path) => resolve(path))));
  }
}

function scanSensitiveFile(rootPath: string, filePath: string, shouldMask: boolean): FileScanResult {
  if (isWholeFileMaskFile(filePath)) {
    const relativeFile = relativePath(rootPath, filePath);
    const finding = findingSnapshot({
      rootPath,
      filePath,
      offset: 0,
      ruleId: "whole-sensitive-file",
      ruleName: "Sensitive credential/license file",
      group: "file",
      key: extname(filePath).toLowerCase() || basename(filePath),
      value: "file-content",
      preview: `${relativeFile}: ${MASK_VALUE}`
    });
    const nextText = `${WHOLE_FILE_MASK_TEXT}Original file: ${relativeFile.replace(/\\/g, "/")}\n`;
    let changed = false;
    if (shouldMask) {
      let current = "";
      try {
        current = readFileSync(filePath, "utf8");
      } catch {
        current = "";
      }
      if (current !== nextText) {
        writeFileSync(filePath, nextText, "utf8");
        changed = true;
      }
    }
    return { findings: [finding], changed };
  }

  let original: string;
  try {
    original = readFileSync(filePath, "utf8");
  } catch {
    return { findings: [], changed: false };
  }

  const transformed = maskSensitiveText(rootPath, filePath, original);
  if (shouldMask && transformed.text !== original) {
    writeFileSync(filePath, transformed.text, "utf8");
    return { findings: transformed.findings, changed: true };
  }
  return { findings: transformed.findings, changed: false };
}

function maskSensitiveText(rootPath: string, filePath: string, input: string): TextTransformResult {
  let text = input;
  const findings: SensitiveFindingSnapshot[] = [];
  const fileKind = isSourceFile(filePath) ? "source" : "config";

  text = text.replace(PRIVATE_KEY_BLOCK_PATTERN, (match: string, offset: number) => {
    findings.push(valueFinding(rootPath, filePath, text, offset, "private-key-block", "Private key block", "private-key", "privateKey", match));
    return MASK_VALUE;
  });

  text = text.replace(ASPOSE_LICENSE_VALUE_PATTERN, (match, prefix: string, value: string, suffix: string, offset: number) => {
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "aspose-license-data", "Aspose license data", "license", "asposeLicense", value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  text = text.replace(JSON_VALUE_PATTERN, (match, prefix: string, key: string, value: string, suffix: string, offset: number) => {
    if (!shouldMaskValue(key, value, fileKind)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "json-sensitive-value", "Sensitive JSON value", "json", key, value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  text = text.replace(JSON_CONNECTION_VALUE_PATTERN, (match, prefix: string, key: string, value: string, suffix: string, offset: number) => {
    if (!shouldMaskConnectionValue(value)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "json-connection-string", "JSON connection string", "connection", key, value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  text = text.replace(XML_VALUE_PATTERN, (match, prefix: string, key: string, value: string, suffix: string, offset: number) => {
    if (!shouldMaskValue(key, value, fileKind)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "xml-sensitive-value", "Sensitive XML value", "xml", key, value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  text = text.replace(XML_CONNECTION_VALUE_PATTERN, (match, prefix: string, key: string, value: string, suffix: string, offset: number) => {
    if (!shouldMaskConnectionValue(value)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "xml-connection-string", "XML connection string", "connection", key, value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  if (fileKind !== "source") {
    text = text.replace(KEY_VALUE_PATTERN, (match, prefix: string, key: string, quote: string, value: string, endQuote: string, tail: string, offset: number) => {
      if (!shouldMaskValue(key, value, fileKind)) return match;
      findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length + quote.length, "key-value-sensitive", "Sensitive key/value", "key-value", key, value));
      return `${prefix}${quote}${MASK_VALUE}${endQuote}${tail}`;
    });

    text = text.replace(CONNECTION_KEY_VALUE_PATTERN, (match, prefix: string, key: string, quote: string, value: string, endQuote: string, tail: string, offset: number) => {
      if (!shouldMaskConnectionValue(value)) return match;
      findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length + quote.length, "key-value-connection-string", "Connection key/value", "connection", key, value));
      return `${prefix}${quote}${MASK_VALUE}${endQuote}${tail}`;
    });
  }

  text = text.replace(SOURCE_ASSIGNMENT_PATTERN, (match, prefix: string, quote: string, value: string, endQuote: string, offset: number) => {
    const key = sourceKeyFromAssignment(prefix);
    if (!shouldMaskValue(key, value, fileKind)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length + quote.length, "source-sensitive-literal", "Sensitive source literal", "source", key, value));
    return `${prefix}${quote}${MASK_VALUE}${endQuote}`;
  });

  text = text.replace(AUTH_HEADER_PATTERN, (match, prefix: string, value: string, suffix: string, offset: number) => {
    if (!isAuthorizationValue(value) && !looksSecretLike(value)) return match;
    findings.push(valueFinding(rootPath, filePath, text, offset + prefix.length, "authorization-header", "Authorization header value", "source", "Authorization", value));
    return `${prefix}${MASK_VALUE}${suffix}`;
  });

  text = text.replace(CONNECTION_STRING_PATTERN, (match, quote: string, value: string, endQuote: string, offset: number) => {
    findings.push(valueFinding(rootPath, filePath, text, offset + quote.length, "connection-string", "Connection string", "connection", "connectionString", value));
    return `${quote}${MASK_VALUE}${endQuote}`;
  });

  for (const tokenPattern of TOKEN_PATTERNS) {
    text = text.replace(tokenPattern.regex, (match: string, value: string, offset: number) => {
      findings.push(valueFinding(rootPath, filePath, text, offset, tokenPattern.ruleId, tokenPattern.ruleName, "token", tokenPattern.ruleName, value));
      return MASK_VALUE;
    });
  }

  return { text, findings: dedupeFindings(findings) };
}

function shouldMaskValue(key: string, value: string, fileKind: "source" | "config") {
  const clean = stripWrappingQuotes(value).trim();
  if (!clean || clean === MASK_VALUE || clean.includes(MASK_VALUE)) return false;
  if (/^(?:true|false|null|undefined|none)$/i.test(clean)) return false;
  if (isLikelyEndpointPath(clean) && !isConnectionString(clean)) return false;
  if (looksLikeKnownPlaceholder(clean) || looksLikeStructuralCodeValue(clean) || looksLikeVersionRange(clean)) return false;
  if (looksLikeSchemaDescriptor(clean) || looksLikeRegexPatternList(clean)) return false;
  if (isConnectionKey(key) && shouldMaskConnectionValue(clean)) return true;
  if (shouldMaskConnectionValue(clean) || isAuthorizationValue(clean) || hasKnownTokenShape(clean)) return true;
  if (isBenignSensitiveKey(key)) return false;
  if (fileKind === "source" && (looksLikeCodeExpression(clean) || isIdentifierLike(clean))) return false;
  if (looksLikeConfigReference(clean)) return false;
  if (isStrongSensitiveKey(key)) return true;
  if (fileKind !== "source" && isSensitiveKey(key)) return true;
  return isSensitiveKey(key) && looksSecretLike(clean);
}

function shouldMaskConnectionValue(value: string) {
  const clean = stripWrappingQuotes(value).trim();
  if (!clean || clean === MASK_VALUE || clean.includes(MASK_VALUE)) return false;
  if (looksLikeConfigReference(clean) || looksLikeKnownPlaceholder(clean)) return false;
  return isConnectionString(clean) || hasCredentialedUri(clean) || hasSensitiveQuerySecret(clean);
}

function valueFinding(
  rootPath: string,
  filePath: string,
  text: string,
  offset: number,
  ruleId: string,
  ruleName: string,
  group: string,
  key: string,
  value: string
) {
  return findingSnapshot({
    rootPath,
    filePath,
    offset,
    ruleId,
    ruleName,
    group,
    key,
    value,
    preview: previewAt(text, offset, value)
  });
}

function findingSnapshot(args: {
  rootPath: string;
  filePath: string;
  offset: number;
  ruleId: string;
  ruleName: string;
  group: string;
  key: string;
  value: string;
  preview: string;
}): SensitiveFindingSnapshot {
  const file = relativePath(args.rootPath, args.filePath);
  const line = lineNumberAt(readSafeText(args.filePath), args.offset);
  const fingerprint = createHash("sha1")
    .update(`${file}:${line}:${args.ruleId}:${args.key}`)
    .digest("hex")
    .slice(0, 20);

  return {
    id: fingerprint,
    ruleId: args.ruleId,
    ruleName: args.ruleName,
    severity: "high",
    group: args.group,
    file,
    line,
    key: args.key,
    preview: args.preview,
    redactedValue: MASK_VALUE,
    confidence: 90,
    maskable: true
  };
}

function previewAt(text: string, offset: number, value: string) {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextNewLine = text.indexOf("\n", offset);
  const end = nextNewLine >= 0 ? nextNewLine : text.length;
  const line = text.slice(start, end).trim();
  if (!line) return MASK_VALUE;
  return line.replace(value, MASK_VALUE).slice(0, 300);
}

function dedupeFindings(findings: SensitiveFindingSnapshot[]) {
  const seen = new Set<string>();
  const result: SensitiveFindingSnapshot[] = [];
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.ruleId}:${finding.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function summarize(findings: SensitiveFindingSnapshot[]): SensitiveSummary {
  const files = new Set(findings.map((finding) => finding.file));
  return {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
    files: files.size,
    maskable: findings.filter((finding) => finding.maskable).length
  };
}

function projectInputsFromPayload(payload: Record<string, unknown>): ProjectInput[] {
  const projects = Array.isArray(payload.projects) ? payload.projects.filter(isRecord).map((item) => item as ProjectInput) : [];
  if (projects.length > 0) return projects;

  const paths = arrayOfStrings(payload.projectPaths || payload.selectedProjects || payload.targetPath);
  if (paths.length > 0) return paths.map((path) => ({ path, name: basename(path), label: basename(path), selected: true }));

  const roots = arrayOfStrings(payload.projectRoots);
  return roots.map((path) => ({ path, name: basename(path), label: basename(path), selected: true }));
}

function looksLikeSourceProject(path: string) {
  const markers = ["src", ".git", "pom.xml", "build.gradle", "package.json", "settings.gradle", "gradlew", "tsconfig.json"];
  return markers.some((marker) => existsSync(join(path, marker)));
}

function isTextFile(path: string) {
  const name = basename(path).toLowerCase();
  if (TEXT_BASENAMES.has(name) || name.startsWith(".env.")) return true;
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSourceFile(path: string) {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isWholeFileMaskFile(path: string) {
  return WHOLE_FILE_MASK_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSensitiveKey(key: string) {
  return new RegExp(SENSITIVE_KEY_FRAGMENT, "i").test(key);
}

function isStrongSensitiveKey(key: string) {
  return /password|passwd|pwd|secret|credential|private[_-]?key|client[_-]?secret|api[_-]?key|apikey|license[_-]?key|activation[_-]?key|encryption[_-]?key|master[_-]?key/i.test(key);
}

function isConnectionKey(key: string) {
  return new RegExp(CONNECTION_KEY_FRAGMENT, "i").test(key);
}

function isBenignSensitiveKey(key: string) {
  return /(?:ignore|ignored|ignores|exclude|excluded|excludes|allow|allowed|allows|minimum|maximum|min|max|length|policy|schema|type|field|column|label|name|base|csrf|xsrf)/i.test(key);
}

function normalizeKey(key: string) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function stripWrappingQuotes(value: string) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isConnectionString(value: string) {
  return /^(?:jdbc:|mongodb(?:\+srv)?:\/\/|redis:\/\/|amqps?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|sqlserver:|oracle:thin:)/i.test(value);
}

function hasCredentialedUri(value: string) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i.test(value);
}

function hasSensitiveQuerySecret(value: string) {
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return false;
  return value
    .slice(queryIndex + 1)
    .split(/[&;]/)
    .some((part) => {
      const [key, rawValue = ""] = part.split("=");
      if (!/(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)/i.test(key)) return false;
      const decoded = safeDecodeURIComponent(rawValue.replace(/\+/g, " "));
      return decoded.length >= 4 && !looksLikeConfigReference(decoded) && !looksLikeKnownPlaceholder(decoded);
    });
}

function isAuthorizationValue(value: string) {
  return /^(?:Bearer|Basic)\s+\S{8,}$/i.test(value.trim());
}

function hasKnownTokenShape(value: string) {
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(value);
  });
}

function isLikelyEndpointPath(value: string) {
  const clean = value.trim();
  if (!clean || /\s/.test(clean)) return false;
  if (isConnectionString(clean)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(clean)) return false;
  if (!clean.includes("/")) return false;
  if (/[=+]/.test(clean)) return false;
  return /^[A-Za-z0-9_./:{}?&%-]+\/?$/.test(clean);
}

function isIdentifierLike(value: string) {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function looksLikeCodeExpression(value: string) {
  const clean = value.trim();
  return (
    /^(?:new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(.*\)$/.test(clean) ||
    /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)+$/.test(clean) ||
    /^(?:this|self|super)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(clean)
  );
}

function looksLikeStructuralCodeValue(value: string) {
  return /^[{[(]$/.test(value.trim());
}

function looksLikeVersionRange(value: string) {
  const clean = value.trim();
  const semver = String.raw`[~^<>=*\s]*(?:v)?\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?`;
  return new RegExp(`^${semver}(?:\\s*\\|\\|\\s*${semver})*$`).test(clean);
}

function looksLikeSchemaDescriptor(value: string) {
  return /^(?:string|number|integer|boolean|object|array|null|date|date-time|uuid|email|uri|binary|byte|int32|int64|float|double)$/i.test(value);
}

function looksLikeRegexPatternList(value: string) {
  const clean = value.trim();
  if (clean.length > 240) return false;
  if (!/[()[\]\\^$*+?]/.test(clean)) return false;
  return /^[/`'"]?[\s,|()[\]{}\\^$*+?.:=!<>\-/A-Za-z0-9]+[/`'"]?$/.test(clean);
}

function looksSecretLike(value: string) {
  const clean = value.trim();
  if (clean.length < 12) return false;
  if (isLikelyEndpointPath(clean)) return false;
  const hasLower = /[a-z]/.test(clean);
  const hasUpper = /[A-Z]/.test(clean);
  const hasDigit = /\d/.test(clean);
  const hasSymbol = /[^A-Za-z0-9]/.test(clean);
  return [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length >= 2;
}

function looksLikeConfigReference(value: string) {
  return (
    /^\$\{[^}]+\}$/.test(value) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^%[A-Za-z0-9_.-]+%$/.test(value) ||
    /^(?:process\.env|import\.meta\.env|System\.getenv|env\.|config\.|this\.|self\.)/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*\)?$/.test(value)
  );
}

function looksLikeKnownPlaceholder(value: string) {
  return /^(?:changeme|change-me|dummy|example|sample|fake|mock|placeholder|redacted|masked|password|passwd|pwd|secret|token|api[-_.]?key|access[-_.]?token|refresh[-_.]?token|username|user)$/i.test(value) || /^your[-_.]?[a-z0-9_-]+$/i.test(value);
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sourceKeyFromAssignment(prefix: string) {
  const matches = prefix.match(/[A-Za-z_$][\w$]*/g);
  return matches?.[matches.length - 1] || "sourceLiteral";
}

function requireDirectory(path: string, label: string) {
  if (!path.trim()) throw new Error(`${label} is required`);
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function relativePath(rootPath: string, filePath: string) {
  const path = relative(rootPath, filePath);
  return path && !path.startsWith("..") ? path : filePath;
}

function readSafeText(filePath: string) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function lineNumberAt(text: string, offset: number) {
  if (offset <= 0) return 1;
  return text.slice(0, offset).split(/\r\n|\n|\r/).length;
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [] as Dirent<string>[];
  }
}

function listDrives() {
  const drives: Array<{ name: string; path: string; is_dir: boolean }> = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const path = `${letter}:\\`;
    if (existsSync(path)) drives.push({ name: `${letter}:`, path, is_dir: true });
  }
  return drives;
}

function arrayOfStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? stringValue(item.path) : String(item ?? "").trim()))
    .filter(Boolean);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function timestamp() {
  const date = new Date();
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.trunc(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date.toISOString().replace(/\.\d{3}Z$/, "")}${sign}${hh}${mm}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
