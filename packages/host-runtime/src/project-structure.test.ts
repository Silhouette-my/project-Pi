import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectProjectGit, readProjectGitDiff } from "./project-git.js";
import { collectProjectArchitecture, readProjectStructureFile } from "./project-architecture.js";

const directories: string[] = [];
async function fixture() { const path = await mkdtemp(join(tmpdir(), "pi-structure-")); directories.push(path); return path; }
function git(path: string, ...args: string[]) { return execFileSync("git", args, { cwd: path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim(); }
function root(path: string) { return { rootId: path, rootPath: path, label: "Fixture" }; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("project Git read side", () => {
  it("returns real refs, merge parents, working changes and commit patches", async () => {
    const path = await fixture();
    git(path, "init", "-b", "main"); git(path, "config", "user.name", "Fixture"); git(path, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(path, "base.txt"), "base\n"); git(path, "add", "base.txt"); git(path, "commit", "-m", "Initial");
    const first = git(path, "rev-parse", "HEAD");
    git(path, "checkout", "-b", "topic"); await writeFile(join(path, "topic.txt"), "topic\n"); git(path, "add", "topic.txt"); git(path, "commit", "-m", "Topic");
    git(path, "checkout", "main"); await writeFile(join(path, "main.txt"), "main\n"); git(path, "add", "main.txt"); git(path, "commit", "-m", "Main");
    git(path, "merge", "--no-ff", "topic", "-m", "Merge topic");
    await writeFile(join(path, "base.txt"), "dirty\n"); await writeFile(join(path, "untracked.txt"), "new\n");
    const snapshot = await collectProjectGit(root(path));
    expect(snapshot.error).toBeUndefined(); expect(snapshot.isRepository).toBe(true);
    expect(snapshot.commits[0]?.parents).toHaveLength(2);
    expect(snapshot.refs.map((item) => item.name)).toEqual(expect.arrayContaining(["main", "topic"]));
    expect(snapshot.changes.files.map((item) => item.path)).toEqual(expect.arrayContaining(["base.txt", "untracked.txt"]));
    expect((await readProjectGitDiff(path, first)).files[0]?.path).toBe("base.txt");
    expect((await readProjectGitDiff(path, snapshot.head ?? "")).files.map((item) => item.path)).toContain("topic.txt");
    await expect(readProjectGitDiff(path, "--output=/tmp/not-allowed")).rejects.toThrow("full commit");
    const sub = join(path, "sub"); await mkdir(sub);
    expect((await collectProjectGit(root(sub))).error).toContain("not the Git repository root");
  });
  it("distinguishes a non-repository and an unborn repository", async () => {
    const path = await fixture(); expect((await collectProjectGit(root(path))).isRepository).toBe(false);
    git(path, "init", "-b", "main"); await writeFile(join(path, "new.txt"), "hello\n");
    const snapshot = await collectProjectGit(root(path));
    expect(snapshot.error).toBeUndefined(); expect(snapshot.isRepository).toBe(true); expect(snapshot.head).toBeNull(); expect(snapshot.commits).toEqual([]);
    expect(snapshot.changes.files[0]?.path).toBe("new.txt");
  });
  it("bounds the DAG and disables repository-configured executables and inherited Git redirects", async () => {
    const path = await fixture(), unrelated = await fixture(); git(path, "init", "-b", "main");
    const stream = Array.from({ length: 202 }, (_, i) => `commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ${1700000000 + i} +0000\ndata ${`Commit ${i}`.length}\nCommit ${i}\n\n`).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: path, input: stream });
    const marker = join(path, "must-not-run");
    git(path, "config", "core.fsmonitor", `touch '${marker}'`); git(path, "config", "diff.external", `touch '${marker}'`);
    git(path, "config", "diff.hostile.textconv", `touch '${marker}'`);
    await writeFile(join(path, ".gitattributes"), "*.txt diff=hostile\n"); await writeFile(join(path, "dirty.txt"), "test\n");
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = join(unrelated, ".git");
    try {
      const snapshot = await collectProjectGit(root(path)); expect(snapshot.error).toBeUndefined(); expect(snapshot.commits).toHaveLength(200); expect(snapshot.truncated).toBe(true);
      expect(snapshot.changes.files.map((file) => file.path)).toContain("dirty.txt");
    } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
    await expect(access(marker)).rejects.toThrow();
  });
  it("reads SHA-256 unborn worktrees and root commit details without writing an empty-tree object", async () => {
    const path = await fixture(); git(path, "init", "--object-format=sha256", "-b", "main");
    git(path, "config", "user.name", "Fixture"); git(path, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(path, "first.txt"), "first\n"); git(path, "add", "first.txt");
    const unborn = await collectProjectGit(root(path));
    expect(unborn.error).toBeUndefined(); expect(unborn.head).toBeNull(); expect(unborn.changes.files[0]?.path).toBe("first.txt");
    git(path, "commit", "-m", "First SHA-256 commit");
    const oid = git(path, "rev-parse", "HEAD"); expect(oid).toHaveLength(64);
    const diff = await readProjectGitDiff(path, oid); expect(diff.files[0]?.path).toBe("first.txt"); expect(diff.files[0]?.status).toBe("added");
  });
});

describe("project architecture read side", () => {
  it("discovers actual diagrams, links root-relative output and reports bad JSON", async () => {
    const path = await fixture(); await mkdir(join(path, ".archify", "nested"), { recursive: true });
    const data = { schema_version: 1, diagram_type: "architecture", meta: { title: "A diagram", output: ".archify/nested/view.html", repository: { revision: "a".repeat(40) } }, components: [{ sources: [{ path: "src/file.ts", line: 2, end_line: 4 }] }] };
    await writeFile(join(path, ".archify/nested/candidate.json"), JSON.stringify(data));
    await writeFile(join(path, ".archify/nested/view.html"), "<!doctype html><title>HTML title</title>");
    await writeFile(join(path, ".archify/nested/view.finalize.json"), "{}");
    await writeFile(join(path, ".archify/nested/bad.json"), "{");
    await writeFile(join(path, ".archify/nested/unknown.json"), "{}");
    const snapshot = await collectProjectArchitecture("project", [root(path)]);
    expect(snapshot.artifacts).toHaveLength(2);
    const html = snapshot.artifacts.find((item) => item.kind === "html");
    expect(html?.title).toBe("A diagram"); expect(html?.repositoryRevision).toBe("a".repeat(40)); expect(html?.sources).toEqual([{ path: "src/file.ts", line: 2, endLine: 4 }]);
    expect(snapshot.errors.map((item) => item.relativePath)).toEqual(expect.arrayContaining([".archify/nested/bad.json", ".archify/nested/unknown.json"]));
    const file = await readProjectStructureFile(path, ".archify/nested/view.html", "artifact"); expect(file.language).toBe("html"); expect(file.currentWorkingFile).toBe(false);
  });
  it("rejects traversal, absolute paths, outside symlinks, binary and oversized files", async () => {
    const path = await fixture(), outside = await fixture(); await mkdir(join(path, ".archify"));
    await writeFile(join(outside, "secret.html"), "private fixture"); await symlink(join(outside, "secret.html"), join(path, ".archify", "escape.html"));
    await writeFile(join(path, ".archify", "large.html"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(join(path, "binary"), Buffer.from([1, 0, 2]));
    for (const name of ["../secret.html", "/secret.html", "C:/secret.html", ".archify/../secret.html", ".archify\\escape.html"]) await expect(readProjectStructureFile(path, name, "artifact")).rejects.toThrow();
    await expect(readProjectStructureFile(path, ".archify/escape.html", "artifact")).rejects.toThrow("escapes");
    await expect(readProjectStructureFile(path, "binary", "source")).rejects.toThrow("Binary");
    const snapshot = await collectProjectArchitecture("project", [root(path)]); expect(snapshot.artifacts).toEqual([]); expect(snapshot.errors).toHaveLength(2);
    expect((await readProjectStructureFile(outside, "secret.html", "source")).currentWorkingFile).toBe(true);
  });
  it("bounds the discovered artifact inventory and reports truncation", async () => {
    const path = await fixture(); await mkdir(join(path, ".archify"));
    await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(path, ".archify", `${i}.html`), "<title>Diagram</title>")));
    const snapshot = await collectProjectArchitecture("project", [root(path)]); expect(snapshot.artifacts).toHaveLength(100); expect(snapshot.truncated).toBe(true);
  });
});
