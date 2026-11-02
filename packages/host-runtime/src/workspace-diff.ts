import { spawn } from "node:child_process";
import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  WorkspaceDiff,
} from "@pi-desktop/shared";

/**
 * Working-tree diff collection for the work panel review tab (D098).
 *
 * Everything textual is parsed by the pure functions below so they stay
 * unit-testable without a git checkout; only `collectWorkspaceDiff` talks
 * to the git CLI.
 */

export const MAX_DIFF_FILES = 100;
export const MAX_PATCH_BYTES = 200 * 1024;

type RunResult = { code: number; stdout: string; stderr: string };

const NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

const REDIRECT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
    };
    for (const name of Object.keys(env)) {
      if ((REDIRECT_ENV as readonly string[]).includes(name) || /^GIT_CONFIG_(KEY|VALUE)_/.test(name)) delete env[name];
    }

    const child = spawn(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${NULL_HOOKS_PATH}`,
        "-c", "core.pager=cat",
        "-c", "core.quotepath=false",
        ...args,
      ],
      { cwd, env },
    );
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Git read timed out")); }, 15000);
    const append = (data: Buffer, error: boolean) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill(); reject(new Error("Git output exceeds the 4 MiB read limit")); return;
      }
      if (error) stderr += String(data); else stdout += String(data);
    };
    child.stdout.on("data", (data: Buffer) => append(data, false));
    child.stderr.on("data", (data: Buffer) => append(data, true));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export type StatusEntry = {
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  untracked: boolean;
};

/**
 * Parse `git status --porcelain=v1 -z` output. Rename entries consume the
 * following NUL record (new path first, then original).
 */
export function parseStatusZ(raw: string): StatusEntry[] {
  const records = raw.split("\0").filter((r) => r.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy === "!!") continue;
    if (xy.includes("R") || xy.includes("C")) {
      const oldPath = records[i + 1];
      i += 1;
      entries.push({ path, oldPath, untracked: false });
    } else {
      entries.push({ path, untracked: xy === "??" });
    }
  }
  return entries;
}

/** Split one `git diff` stream into per-file patch chunks. */
export function splitUnifiedDiff(raw: string): string[] {
  if (!raw.trim()) return [];
  const chunks: string[] = [];
  const lines = raw.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

/** Strip the a/ or b/ prefix git adds to diff header paths. */
function stripPathPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

/**
 * Parse a single-file unified diff chunk into a DiffFile. `statusHint`
 * overrides the derived status (used to mark untracked files, which are
 * diffed via --no-index and would otherwise read as "added").
 */
export function parseFilePatch(
  chunk: string,
  statusHint?: DiffFileStatus,
): DiffFile | null {
  const lines = chunk.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return null;

  let path = "";
  let oldPath: string | undefined;
  let status: DiffFileStatus = statusHint ?? "modified";
  let binary = false;
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") oldPath = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") path = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (!statusHint) status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = unquoteGitPath(line.slice("rename from ".length).trim());
      status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      path = unquoteGitPath(line.slice("rename to ".length).trim());
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "add", text: line.slice(1) } satisfies DiffLine);
    } else if (line.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "del", text: line.slice(1) } satisfies DiffLine);
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push({
        type: "context",
        text: line.slice(1),
      } satisfies DiffLine);
    }
    // "\ No newline at end of file" markers are dropped.
  }

  if (!path && oldPath) path = oldPath; // deletions have no +++ path
  if (!path) {
    // Binary patches carry no ---/+++ lines; recover the path from the
    // `diff --git a/<p> b/<p>` header (quoted paths included).
    const header = lines[0].slice("diff --git ".length).trim();
    const quoted = header.match(/"((?:[^"\\]|\\.)*)"\s*$/);
    const bPath = quoted
      ? unquoteGitPath(`"${quoted[1]}"`)
      : header.split(" b/").pop() ?? "";
    path = stripPathPrefix(bPath);
  }
  if (!path) return null;

  const tooLarge = chunk.length > MAX_PATCH_BYTES;
  return {
    path,
    oldPath: status === "renamed" ? oldPath : undefined,
    status,
    additions,
    deletions,
    binary: binary || undefined,
    tooLarge: tooLarge || undefined,
    hunks: binary || tooLarge ? [] : hunks,
  };
}

export async function collectWorkspaceDiff(cwd: string): Promise<WorkspaceDiff> {
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    if (probe.code !== 0 && !/not a git repository/i.test(probe.stderr)) throw new Error(probe.stderr.trim() || "Git read failed");
    return { repo: false, clean: true, files: [] };
  }

  const status = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--", ".",
  ]);
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || "Git status failed");
  }
  const prefixResult = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  if (prefixResult.code !== 0) throw new Error(prefixResult.stderr.trim() || "Git path lookup failed");
  const prefix = prefixResult.stdout.trim();
  const entries = parseStatusZ(status.stdout).map((entry) => ({ ...entry, path: prefix ? entry.path.slice(prefix.length) : entry.path }));
  if (entries.length === 0) {
    return { repo: true, clean: true, files: [], stagedFiles: [], unstagedFiles: [] };
  }

  const truncated = entries.length > MAX_DIFF_FILES;
  const scoped = entries.slice(0, MAX_DIFF_FILES);
  const untrackedPaths = new Set(
    scoped.filter((e) => e.untracked).map((e) => e.path),
  );

  // Keep the aggregate files view for existing consumers and expose the index
  // and working tree separately: staged edits can cancel out in the net diff.
  const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const empty = head.code === 0 ? null : await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"]);
  if (empty && empty.code !== 0) throw new Error(empty.stderr.trim() || "Git empty tree lookup failed");
  const base = head.code === 0 ? "HEAD" : empty!.stdout.trim();
  const trackedDiff = async (layer: string[]) => {
    const result = await runGit(cwd, ["diff", "--relative", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3", ...layer, "--", "."]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Git diff failed");
    return splitUnifiedDiff(result.stdout).flatMap((chunk) => {
      const file = parseFilePatch(chunk);
      return file && !untrackedPaths.has(file.path) ? [file] : [];
    });
  };
  const files = await trackedDiff([base]);
  const stagedFiles = await trackedDiff(["--cached", base]);
  const unstagedFiles = await trackedDiff([]);

  // Untracked files: --no-index against /dev/null; exit code 1 means "differs".
  for (const entry of scoped) {
    if (!entry.untracked) continue;
    const res = await runGit(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--no-index",
      "--",
      "/dev/null",
      entry.path,
    ]);
    if (res.code > 1) throw new Error(res.stderr.trim() || "Untracked file diff failed");
    const chunk = splitUnifiedDiff(res.stdout)[0];
    const file = chunk ? parseFilePatch(chunk, "untracked") : null;
    if (file) {
      files.push(file);
      unstagedFiles.push(file);
    } else {
      // Unreadable or empty new file — still list it.
      const emptyFile: DiffFile = {
        path: entry.path,
        status: "untracked",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(emptyFile);
      unstagedFiles.push(emptyFile);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo: true,
    clean: false,
    files: files.slice(0, MAX_DIFF_FILES),
    stagedFiles: stagedFiles.slice(0, MAX_DIFF_FILES),
    unstagedFiles: unstagedFiles.slice(0, MAX_DIFF_FILES),
    truncated: truncated || files.length > MAX_DIFF_FILES || stagedFiles.length > MAX_DIFF_FILES || unstagedFiles.length > MAX_DIFF_FILES || undefined,
  };
}
