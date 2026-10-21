import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { ProjectGitRepository, ProjectStructureRoot, WorkspaceDiff } from "@pi-desktop/shared";
import { parseFilePatch, parseStatusZ, splitUnifiedDiff } from "./workspace-diff.js";

const MAX_COMMITS = 200;
const MAX_FILES = 100;
const MAX_OUTPUT = 4 * 1024 * 1024;
const REDIRECT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];

/** Fixed local read commands only; no shell, hooks, filters, network or lazy fetching. */
async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of Object.keys(env)) if (REDIRECT_ENV.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.pager=cat", ...args], { cwd, env });
    child.stdin.end();
    let stdout = "", stderr = "", bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Git read timed out")); }, 15000);
    const append = (data: Buffer, error: boolean) => {
      bytes += data.length;
      if (bytes > MAX_OUTPUT) { child.kill(); reject(new Error("Git output exceeds the 4 MiB read limit")); return; }
      if (error) stderr += String(data); else stdout += String(data);
    };
    child.stdout.on("data", (data: Buffer) => append(data, false));
    child.stderr.on("data", (data: Buffer) => append(data, true));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function required(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Git read failed");
  return result.stdout;
}

export function validateCommitOid(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error("A full commit object ID is required");
}

async function repositoryRoot(rootPath: string): Promise<boolean> {
  const result = await git(rootPath, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return false;
  // A registered subdirectory must not expose the enclosing, unregistered repository.
  if (await realpath(result.stdout.trim()) !== await realpath(rootPath)) throw new Error("The registered root is not the Git repository root");
  return true;
}

/** Diffs are bounded and reuse the work-panel hunk contract. A merge uses its first parent. */
export async function readProjectGitDiff(rootPath: string, commit?: string): Promise<WorkspaceDiff> {
  if (commit) validateCommitOid(commit);
  if (!await repositoryRoot(rootPath)) return { repo: false, clean: true, files: [] };
  let base: string, target: string | undefined;
  let untracked: string[] = [];
  if (commit) {
    const resolved = (await required(rootPath, ["rev-parse", "--verify", `${commit}^{commit}`])).trim();
    if (resolved.toLowerCase() !== commit.toLowerCase()) throw new Error("Object is not a commit");
    const parents = (await required(rootPath, ["rev-list", "--parents", "-n", "1", commit, "--"])).trim().split(" ");
    base = parents[1] ?? (await required(rootPath, ["hash-object", "-t", "tree", "--stdin"])).trim();
    target = commit;
  } else {
    const head = await git(rootPath, ["rev-parse", "--verify", "HEAD"]);
    // No -w: compute the repository-format empty tree without writing an object.
    base = head.code === 0 ? head.stdout.trim() : (await required(rootPath, ["hash-object", "-t", "tree", "--stdin"])).trim();
    const status = parseStatusZ(await required(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    untracked = status.filter((entry) => entry.untracked).map((entry) => entry.path);
  }
  const raw = await required(rootPath, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3", base, ...(target ? [target] : []), "--"]);
  const files = splitUnifiedDiff(raw).flatMap((chunk) => { const file = parseFilePatch(chunk); return file ? [file] : []; });
  const total = files.length + untracked.length;
  for (const path of untracked.slice(0, Math.max(0, MAX_FILES - files.length))) {
    const diff = await git(rootPath, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "--no-index", "--", "/dev/null", path]);
    if (diff.code > 1) throw new Error(diff.stderr.trim() || "Untracked file diff failed");
    const chunk = splitUnifiedDiff(diff.stdout)[0];
    const file = chunk ? parseFilePatch(chunk, "untracked") : null;
    files.push(file ?? { path, status: "untracked", additions: 0, deletions: 0, hunks: [] });
  }
  return { repo: true, clean: total === 0, files: files.slice(0, MAX_FILES), truncated: total > MAX_FILES || undefined };
}

export async function collectProjectGit(root: ProjectStructureRoot): Promise<ProjectGitRepository> {
  const result: ProjectGitRepository = { ...root, isRepository: false, head: null, branch: null, refs: [], commits: [], changes: { repo: false, clean: true, files: [] }, truncated: false };
  try {
    if (!await repositoryRoot(root.rootPath)) return result;
    result.isRepository = true;
    const head = await git(root.rootPath, ["rev-parse", "--verify", "HEAD"]);
    result.head = head.code === 0 ? head.stdout.trim() : null;
    const branch = await git(root.rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    result.branch = branch.code === 0 ? branch.stdout.trim() : null;
    const refs = await required(root.rootPath, ["for-each-ref", "--count=501", "--format=%(refname:short)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"]);
    const allRefs = refs.trim().split("\n").filter(Boolean).map((line) => { const [name, oid, peeled] = line.split("\0"); return { name: name ?? "", oid: peeled || oid || "" }; });
    result.refs = allRefs.slice(0, 500);
    result.truncated = allRefs.length > 500;
    if (result.head || allRefs.length) {
      const raw = await required(root.rootPath, ["log", "--all", ...(result.head ? ["HEAD"] : []), "--topo-order", `--max-count=${MAX_COMMITS + 1}`, "--format=%H%x00%P%x00%s%x00%an%x00%aI", "--"]);
      const lines = raw.trim().split("\n").filter(Boolean);
      result.truncated ||= lines.length > MAX_COMMITS;
      result.commits = lines.slice(0, MAX_COMMITS).map((line) => {
        const [oid = "", parents = "", subject = "", authorName = "", authoredAt = ""] = line.split("\0");
        return { oid, parents: parents.split(" ").filter(Boolean), subject, authorName, authoredAt, refNames: result.refs.filter((ref) => ref.oid === oid).map((ref) => ref.name) };
      });
    }
    result.changes = await readProjectGitDiff(root.rootPath);
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  return result;
}
