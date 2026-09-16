import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";

const SERVER_SCHEMA_VERSION = 2;
const DEFAULT_UK_ROOT = "D:\\src.uk\\UniversalK\\nts.uk";

type ScanOptions = {
  buildBusinessGraph: boolean;
  importSqlite: boolean;
  scanJoern: boolean;
  verifyCpg: boolean;
  pullJoernImage: boolean;
};

type ScanConfig = {
  projectRoots: string[];
  scanOptions: ScanOptions;
  pythonExe: string;
  joernImage: string;
  selectedProjects: string[];
};

type ProjectSpec = {
  name: string;
  label?: string;
  path: string;
  selected?: boolean;
  source?: string;
  root?: string;
};

type ScanProject = {
  name: string;
  path: string;
  git: Record<string, string>;
};

type JobStatus = "queued" | "running" | "completed" | "failed";

class ScanJob {
  readonly id = randomUUID();
  status: JobStatus = "queued";
  started_at: string | null = null;
  finished_at: string | null = null;
  lines: string[] = [];
  result: unknown = null;
  error: string | null = null;

  constructor(readonly payload: Record<string, unknown>) {}

  append(line: unknown) {
    const value = String(line).trimEnd();
    if (!value) return;
    this.lines.push(value);
    this.lines = this.lines.slice(-5000);
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      started_at: this.started_at,
      finished_at: this.finished_at,
      lines: this.lines.slice(-500),
      result: this.result,
      error: this.error
    };
  }
}

export class GraphScanService {
  private readonly jobs = new Map<string, ScanJob>();

  readonly graphRoot = config.graph.rootPath;
  readonly outputRoot = config.graph.outputRootPath;
  readonly businessGraphDir = config.graph.businessGraphDir;
  readonly cpgDir = join(this.outputRoot, "cpg");
  readonly logsDir = join(this.outputRoot, "logs");
  readonly scriptsDir = join(this.graphRoot, "scripts");
  readonly configPath = join(this.outputRoot, "scan-config.json");

  versionPayload() {
    return {
      schemaVersion: SERVER_SCHEMA_VERSION,
      graphRoot: this.graphRoot,
      outputRoot: this.outputRoot,
      configPath: this.configPath
    };
  }

  projectsPayload(rawConfig?: ScanConfig) {
    const scanConfig = this.normalizeConfig(rawConfig ?? this.loadConfig());
    const discovery = this.discoverProjectRoots(scanConfig.projectRoots, scanConfig.selectedProjects);
    return {
      schemaVersion: SERVER_SCHEMA_VERSION,
      graphRoot: this.graphRoot,
      outputRoot: this.outputRoot,
      businessGraphDir: this.businessGraphDir,
      defaults: this.defaultConfig(),
      config: scanConfig,
      projectRoots: discovery.roots,
      projects: discovery.projects
    };
  }

  configFromPayload(payload: unknown) {
    const data = isRecord(payload) ? payload : {};
    const rawOptions = isRecord(data.scanOptions) ? data.scanOptions : {};
    const scanOptions: Record<string, unknown> = { ...rawOptions };
    for (const key of Object.keys(this.defaultConfig().scanOptions)) {
      if (key in data) scanOptions[key] = data[key];
    }

    let selected = arrayOfStrings(data.selectedProjects);
    if (selected.length === 0 && Array.isArray(data.projects)) {
      selected = data.projects
        .filter((item): item is Record<string, unknown> => isRecord(item) && Boolean(item.selected))
        .map((item) => String(item.path ?? item.name ?? ""))
        .filter(Boolean);
    }

    return this.normalizeConfig({
      projectRoots: arrayOfStrings(data.projectRoots ?? data.roots),
      scanOptions: scanOptions as Partial<ScanOptions> as ScanOptions,
      pythonExe: stringValue(data.pythonExe),
      joernImage: stringValue(data.joernImage),
      selectedProjects: selected
    });
  }

  saveConfig(raw: unknown) {
    const scanConfig = this.configFromPayload(raw);
    writeJson(this.configPath, scanConfig);
    return scanConfig;
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
    if (statSync(path).isFile()) path = dirname(path);

    const entries: Array<{ name: string; path: string; is_dir: boolean }> = [];
    try {
      for (const child of readdirSync(path, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })) {
        if (child.isDirectory()) {
          entries.push({ name: child.name, path: join(path, child.name), is_dir: true });
        }
      }
    } catch {
      // Permission denied folders are simply shown as empty.
    }

    const parent = dirname(path);
    return {
      path,
      parent: parent && parent !== path ? parent : null,
      entries,
      exists: true
    };
  }

  startScan(payload: unknown) {
    const data = isRecord(payload) ? payload : {};
    this.saveConfig(data);
    const job = new ScanJob(data);
    this.jobs.set(job.id, job);
    setImmediate(() => {
      void this.runScanJob(job);
    });
    return { jobId: job.id, status: job.status };
  }

  getJob(jobId: string) {
    return this.jobs.get(jobId)?.snapshot() ?? null;
  }

  private async runScanJob(job: ScanJob) {
    job.status = "running";
    job.started_at = timestamp();

    try {
      const projects: ScanProject[] = [];
      const skipped: Array<{ name: string; path: string; reason: string }> = [];
      const rawProjects = Array.isArray(job.payload.projects) ? job.payload.projects : [];

      for (const item of rawProjects) {
        if (!isRecord(item) || !item.selected) continue;
        const itemPath = resolve(String(item.path ?? ""));
        const name = safeName(String(item.name ?? basename(itemPath)));
        if (existsSync(itemPath)) {
          projects.push({ name, path: itemPath, git: await this.gitInfo(itemPath) });
        } else {
          skipped.push({ name, path: itemPath, reason: "folder-not-found" });
        }
      }

      if (projects.length === 0) {
        throw new Error("No existing selected project folders to scan.");
      }

      job.append(`Selected projects: ${projects.map((project) => project.name).join(", ")}`);
      for (const item of skipped) {
        job.append(`[skip] ${item.name}: ${item.path}`);
      }

      const pythonExe = stringValue(job.payload.pythonExe) || config.graph.pythonExe;
      const joernImage = stringValue(job.payload.joernImage) || config.graph.joernImage;
      if (job.payload.pullJoernImage) {
        await this.runLogged(job, "docker pull Joern", ["docker", "pull", joernImage], join(this.logsDir, "docker-pull-joern.log"));
      }

      if (job.payload.scanJoern) {
        for (const project of projects) {
          await this.scanJoern(job, project, joernImage, Boolean(job.payload.verifyCpg));
        }
      }

      mkdirSync(this.businessGraphDir, { recursive: true });
      const selectedPath = join(this.businessGraphDir, "selected-projects.json");
      writeJson(selectedPath, { projects, skipped });

      if (job.payload.buildBusinessGraph !== false) {
        await this.runLogged(
          job,
          "Build business graph",
          [pythonExe, join(this.scriptsDir, "build_business_graph.py"), "--projects-file", selectedPath, "--out-dir", this.businessGraphDir],
          join(this.logsDir, "build-business-graph.log")
        );
        await this.runLogged(
          job,
          "Validate business graph",
          [pythonExe, join(this.scriptsDir, "validate_business_graph.py"), "--graph-root", this.businessGraphDir],
          join(this.logsDir, "validate-business-graph.log")
        );
      }

      if (job.payload.importSqlite !== false) {
        mkdirSync(dirname(config.graph.sqliteDbPath), { recursive: true });
        await this.runLogged(
          job,
          "Import graph SQLite",
          [
            pythonExe,
            join(this.scriptsDir, "import_graph_to_sqlite.py"),
            "--graph-dir",
            this.businessGraphDir,
            "--db",
            config.graph.sqliteDbPath
          ],
          join(this.logsDir, "import-graph-sqlite.log")
        );
      }

      const summaryPath = join(this.businessGraphDir, "summary.json");
      const sqlitePath = config.graph.sqliteDbPath;
      job.status = "completed";
      job.finished_at = timestamp();
      job.result = {
        projects,
        skipped,
        summary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null,
        sqlite: {
          path: sqlitePath,
          size_bytes: existsSync(sqlitePath) ? statSync(sqlitePath).size : null
        }
      };
      job.append("[done] Scan completed.");
    } catch (err) {
      job.status = "failed";
      job.finished_at = timestamp();
      job.error = errorMessage(err);
      job.append(`[error] ${job.error}`);
    }
  }

  private async scanJoern(job: ScanJob, project: ScanProject, joernImage: string, verify: boolean) {
    const source = project.path;
    if (!existsSync(source)) {
      job.append(`[skip] ${project.name}: folder not found`);
      return;
    }

    const graphMount = `${this.outputRoot}:/graph`;
    const scriptsMount = `${this.scriptsDir}:/graph-scripts:ro`;
    const sourceMount = `${source}:/src:ro`;
    mkdirSync(this.cpgDir, { recursive: true });

    const javaTmp = join(this.cpgDir, `${project.name}-java-cpg.bin.zip.tmp`);
    const javaFinal = join(this.cpgDir, `${project.name}-java-cpg.bin.zip`);
    const uiTmp = join(this.cpgDir, `${project.name}-ui-js-cpg.bin.zip.tmp`);
    const uiFinal = join(this.cpgDir, `${project.name}-ui-js-cpg.bin.zip`);
    rmSync(javaTmp, { force: true });
    rmSync(uiTmp, { force: true });

    job.append(`[joern] Java scan: ${project.name}`);
    await this.runLogged(
      job,
      `Joern Java ${project.name}`,
      [
        "docker",
        "run",
        "--rm",
        "-v",
        sourceMount,
        "-v",
        graphMount,
        joernImage,
        "/opt/joern/joern-cli/javasrc2cpg",
        "-J-Xmx3960m",
        "--exclude-regex",
        ".*(node_modules|build|target|\\.gradle|\\.idea).*",
        "/src",
        "--output",
        `/graph/cpg/${project.name}-java-cpg.bin.zip.tmp`
      ],
      join(this.logsDir, `joern-parse-${project.name}-java.log`)
    );
    replaceGenerated(javaTmp, javaFinal);

    job.append(`[joern] UI JS/TS scan: ${project.name}`);
    await this.runLogged(
      job,
      `Joern UI ${project.name}`,
      [
        "docker",
        "run",
        "--rm",
        "-v",
        sourceMount,
        "-v",
        graphMount,
        joernImage,
        "joern-parse",
        "/src",
        "--language",
        "JAVASCRIPT",
        "--output",
        `/graph/cpg/${project.name}-ui-js-cpg.bin.zip.tmp`
      ],
      join(this.logsDir, `joern-parse-${project.name}-ui-js.log`)
    );
    replaceGenerated(uiTmp, uiFinal);

    if (!verify) return;

    job.append(`[joern] Verify CPG: ${project.name}`);
    await this.runLogged(
      job,
      `Verify Java ${project.name}`,
      [
        "docker",
        "run",
        "--rm",
        "-v",
        graphMount,
        "-v",
        scriptsMount,
        joernImage,
        "joern",
        "--script",
        "/graph-scripts/verify-cpg.sc",
        "--param",
        `cpgFile=/graph/cpg/${project.name}-java-cpg.bin.zip`,
        "--param",
        `outFile=/graph/logs/verify-${project.name}-java.txt`
      ],
      join(this.logsDir, `verify-${project.name}-java.log`)
    );
    await this.runLogged(
      job,
      `Verify UI ${project.name}`,
      [
        "docker",
        "run",
        "--rm",
        "-v",
        graphMount,
        "-v",
        scriptsMount,
        joernImage,
        "joern",
        "--script",
        "/graph-scripts/verify-cpg.sc",
        "--param",
        `cpgFile=/graph/cpg/${project.name}-ui-js-cpg.bin.zip`,
        "--param",
        `outFile=/graph/logs/verify-${project.name}-ui-js.txt`
      ],
      join(this.logsDir, `verify-${project.name}-ui-js.log`)
    );
  }

  private runLogged(job: ScanJob, name: string, args: string[], logPath: string) {
    mkdirSync(this.logsDir, { recursive: true });
    const display = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
    job.append(`>>> ${display}`);
    appendFileSync(logPath, `>>> ${display}\n`, "utf8");

    return new Promise<void>((resolvePromise, reject) => {
      const proc = spawn(args[0], args.slice(1), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        appendFileSync(logPath, text, "utf8");
        for (const line of text.split(/\r?\n/)) {
          job.append(line);
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`${name} failed with exit code ${code}`));
        }
      });
    });
  }

  private async gitInfo(path: string) {
    const info: Record<string, string> = {};
    for (const [key, args] of Object.entries({
      branch: ["rev-parse", "--abbrev-ref", "HEAD"],
      commit: ["rev-parse", "HEAD"]
    })) {
      try {
        const output = await runProcess("git", ["-C", path, ...args], 10000);
        if (output.exitCode === 0) info[key] = output.stdout.trim();
      } catch {
        // Git metadata is helpful but not required for scanning.
      }
    }
    return info;
  }

  private discoverProjectRoots(roots: string[], selectedKeys: string[] = []) {
    const discovered: Array<{ root: string; exists: boolean; count: number }> = [];
    const projects: Array<ProjectSpec & { exists: boolean; missing: boolean }> = [];
    const seenPaths = new Set<string>();

    for (const root of roots) {
      const item = this.discoverProjectRoot(root, selectedKeys);
      discovered.push({ root: item.root, exists: item.exists, count: item.projects.length });
      for (const project of item.projects) {
        const key = resolve(project.path).toLowerCase();
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        projects.push(project);
      }
    }

    return { roots: discovered, projects };
  }

  private discoverProjectRoot(root: string, selectedKeys: string[] = []) {
    const selected = new Set(selectedKeys);
    const rootPath = resolve(root);
    if (!existsSync(rootPath)) {
      return { root: rootPath, exists: false, projects: [] as Array<ProjectSpec & { exists: boolean; missing: boolean }> };
    }

    const projects: Array<ProjectSpec & { exists: boolean; missing: boolean }> = [];
    for (const child of readdirSync(rootPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const childPath = join(rootPath, child.name);
      if (looksLikeProject(childPath) || child.name.startsWith("uk.") || child.name.startsWith("nts.uk.")) {
        const project = projectStatus({
          name: child.name,
          label: child.name,
          path: childPath,
          selected: false,
          source: "project-root",
          root: rootPath
        });
        project.selected = selected.has(project.path) || selected.has(project.name);
        projects.push(project);
      }
    }

    if (projects.length === 0 && looksLikeProject(rootPath)) {
      const project = projectStatus({
        name: basename(rootPath),
        label: basename(rootPath),
        path: rootPath,
        selected: false,
        source: "project-root",
        root: rootPath
      });
      project.selected = selected.has(project.path) || selected.has(project.name);
      projects.push(project);
    }

    return { root: rootPath, exists: true, projects };
  }

  private loadConfig() {
    if (!existsSync(this.configPath)) return this.defaultConfig();
    try {
      return this.normalizeConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
    } catch {
      return this.defaultConfig();
    }
  }

  private normalizeConfig(raw?: Partial<ScanConfig>) {
    const base = this.defaultConfig();
    let roots = arrayOfStrings(raw?.projectRoots);
    if (roots.length === 0) roots = base.projectRoots;

    const options: ScanOptions = {
      ...base.scanOptions,
      ...(raw?.scanOptions ?? {})
    };
    for (const key of Object.keys(base.scanOptions) as Array<keyof ScanOptions>) {
      options[key] = Boolean(options[key]);
    }
    if (!options.scanJoern) options.verifyCpg = false;

    return {
      projectRoots: roots,
      scanOptions: options,
      pythonExe: raw?.pythonExe?.trim() || base.pythonExe,
      joernImage: raw?.joernImage?.trim() || base.joernImage,
      selectedProjects: arrayOfStrings(raw?.selectedProjects)
    };
  }

  private defaultConfig(): ScanConfig {
    return {
      projectRoots: [DEFAULT_UK_ROOT],
      scanOptions: {
        buildBusinessGraph: true,
        importSqlite: true,
        scanJoern: true,
        verifyCpg: true,
        pullJoernImage: true
      },
      pythonExe: config.graph.pythonExe,
      joernImage: config.graph.joernImage,
      selectedProjects: []
    };
  }
}

function projectStatus(project: ProjectSpec) {
  const path = resolve(project.path);
  const exists = existsSync(path);
  return {
    ...project,
    name: safeName(project.name || basename(path)),
    path,
    exists,
    missing: !exists
  };
}

function looksLikeProject(path: string) {
  for (const marker of ["build.gradle", "build.gradle.kts", "settings.gradle", "pom.xml", "package.json", "appProperties.gradle"]) {
    if (existsSync(join(path, marker))) return true;
  }
  return existsSync(join(path, "src")) || existsSync(join(path, "src", "main"));
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

function replaceGenerated(tmpPath: string, finalPath: string) {
  if (!existsSync(tmpPath)) {
    throw new Error(`Expected generated file not found: ${tmpPath}`);
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  rmSync(finalPath, { force: true });
  renameSync(tmpPath, finalPath);
}

function runProcess(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolveProcess) => {
    const proc = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      stderr += err.message;
    });
    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveProcess({ stdout, stderr, exitCode });
    });
  });
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeName(value: string) {
  return (value || "project").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
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

function arrayOfStrings(value: unknown) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
