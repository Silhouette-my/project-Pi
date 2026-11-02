import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectArchitectureArtifact, ProjectArchitectureSnapshot, ProjectArchitectureSource, ProjectStructureFile, ProjectStructureRoot } from "@pi-desktop/shared";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_ARTIFACTS = 100;
const MAX_DEPTH = 12;
const RECEIPT = /\.(?:finalize(?:-summary)?|browser-check|delivery|audit|validation|render-summary)\.json$/i;
const DIAGRAM_TYPES = new Set(["architecture", "sequence", "dataflow", "lifecycle", "workflow"]);

export function validateProjectRelativePath(path: string): void {
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error("A project-relative path is required");
}

/** Resolve both boundaries and check the opened file against its contained path. */
async function readContained(rootPath: string, relativePath: string, artifact: boolean): Promise<{ content: string; size: number; modifiedAt: number }> {
  validateProjectRelativePath(relativePath);
  if (artifact && (!relativePath.startsWith(".archify/") || !/\.(?:html|json)$/i.test(relativePath))) throw new Error("Only .archify HTML/JSON artifacts can be read");
  const root = await realpath(rootPath);
  const boundary = artifact ? await realpath(resolve(root, ".archify")) : root;
  if (artifact && !inside(root, boundary)) throw new Error("Architecture directory escapes the project root");
  const canonical = await realpath(resolve(root, relativePath));
  if (!inside(boundary, canonical)) throw new Error("File escapes the authorized project root");
  const expected = await stat(canonical);
  if (!expected.isFile()) throw new Error("Preview requires a regular file");
  if (expected.size > MAX_FILE_BYTES) throw new Error("File exceeds the 2 MiB read limit");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!inside(boundary, await realpath(canonical))) throw new Error("File escapes the authorized project root");
    const current = await stat(canonical);
    if (info.dev !== expected.dev || info.ino !== expected.ino || info.dev !== current.dev || info.ino !== current.ino || !info.isFile()) throw new Error("File changed while opening or is not a regular file");
    if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 2 MiB read limit");
    // Read one bounded buffer, even if a writer grows the file after stat.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error("File exceeds the 2 MiB read limit");
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("Binary files cannot be previewed");
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), size: bytesRead, modifiedAt: info.mtimeMs };
  } finally { await handle.close(); }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function metadata(value: unknown): Pick<ProjectArchitectureArtifact, "title" | "sources" | "repositoryRevision" | "renderedPath"> {
  if (!record(value) || value.schema_version !== 1 || typeof value.diagram_type !== "string" || !DIAGRAM_TYPES.has(value.diagram_type) || !record(value.meta)) throw new Error("Unrecognized Archify diagram JSON (schema_version 1 and diagram_type required)");
  const sources: ProjectArchitectureSource[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 30) throw new Error("Architecture JSON nesting exceeds the read limit");
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (!record(node)) return;
    if ("sources" in node) {
      if (!Array.isArray(node.sources)) throw new Error("Invalid architecture source references");
      for (const source of node.sources) {
        if (!record(source) || typeof source.path !== "string") throw new Error("Invalid architecture source reference");
        validateProjectRelativePath(source.path);
        const line = source.line ?? 1;
        if (!Number.isInteger(line) || Number(line) < 1 || (source.end_line !== undefined && (!Number.isInteger(source.end_line) || Number(source.end_line) < Number(line)))) throw new Error("Invalid architecture source line range");
        sources.push({ path: source.path, line: Number(line), ...(source.end_line === undefined ? {} : { endLine: Number(source.end_line) }) });
        if (sources.length > 1000) throw new Error("Architecture source reference limit exceeded");
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "sources") walk(child, depth + 1);
  };
  walk(value, 0);
  const repository = record(value.meta.repository) ? value.meta.repository : undefined;
  const revision = repository ? text(repository.revision) : undefined;
  if (revision && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error("Invalid architecture repository revision");
  const output = text(value.meta.output);
  if (output) { validateProjectRelativePath(output); if (!output.startsWith(".archify/") || !/\.html$/i.test(output)) throw new Error("Architecture output must be an HTML path within .archify"); }
  return { title: text(value.meta.title), sources, repositoryRevision: revision, renderedPath: output };
}

export async function readProjectStructureFile(rootPath: string, relativePath: string, kind: "artifact" | "source"): Promise<ProjectStructureFile> {
  const { content } = await readContained(rootPath, relativePath, kind === "artifact");
  return { relativePath, content, language: /\.html$/i.test(relativePath) ? "html" : /\.json$/i.test(relativePath) ? "json" : "text", currentWorkingFile: kind === "source", truncated: false };
}

export async function collectProjectArchitecture(projectId: string, roots: ProjectStructureRoot[]): Promise<ProjectArchitectureSnapshot> {
  const snapshot: ProjectArchitectureSnapshot = { projectId, roots, artifacts: [], errors: [], truncated: false };
  let entries = 0;
  for (const root of roots) {
    const report = (relativePath: string | undefined, error: unknown) => snapshot.errors.push({ rootId: root.rootId, relativePath, message: error instanceof Error ? error.message : String(error) });
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) { snapshot.truncated = true; return; }
      const canonical = await realpath(resolve(root.rootPath, directory));
      if (!inside(await realpath(resolve(root.rootPath, ".archify")), canonical)) throw new Error("Architecture directory escapes .archify");
      const children = await opendir(canonical);
      for await (const child of children) {
        if (++entries > MAX_ENTRIES || snapshot.artifacts.length >= MAX_ARTIFACTS) { snapshot.truncated = true; return; }
        const path = `${directory}/${child.name}`;
        if (child.isSymbolicLink()) { report(path, new Error("Symbolic links are not scanned")); continue; }
        if (child.isDirectory()) { try { await visit(path, depth + 1); } catch (error) { report(path, error); } continue; }
        if (!child.isFile() || !/\.(?:html|json)$/i.test(path) || RECEIPT.test(path)) continue;
        try {
          const file = await readContained(root.rootPath, path, true);
          const kind = /\.html$/i.test(path) ? "html" : "json";
          const data = kind === "json" ? metadata(JSON.parse(file.content)) : { title: file.content.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1], sources: [] };
          snapshot.artifacts.push({ rootId: root.rootId, relativePath: path, kind, size: file.size, modifiedAt: file.modifiedAt, ...data });
        } catch (error) { report(path, error); }
      }
    };
    try {
      const architecture = await realpath(resolve(root.rootPath, ".archify"));
      if (!inside(await realpath(root.rootPath), architecture)) throw new Error("Architecture directory escapes the project root");
      await visit(".archify", 0);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) report(".archify", error);
    }
  }
  // Copy diagram metadata onto its actual rendered HTML; output is project-root relative.
  for (const artifact of snapshot.artifacts) if (artifact.renderedPath) {
    const html = snapshot.artifacts.find((item) => item.rootId === artifact.rootId && item.relativePath === artifact.renderedPath && item.kind === "html");
    if (html) { html.title = artifact.title ?? html.title; html.sources = artifact.sources; html.repositoryRevision = artifact.repositoryRevision; }
    else snapshot.errors.push({ rootId: artifact.rootId, relativePath: artifact.relativePath, message: `Rendered HTML not found: ${artifact.renderedPath}` });
  }
  return snapshot;
}
