import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectWorkflowSnapshot, WorkflowRun } from "@pi-desktop/shared";

async function canonicalResource(resource: string): Promise<{ identity: string; ancestor?: string }> {
  const path = resource.startsWith("file:") ? fileURLToPath(resource) : resource;
  if (!isAbsolute(path)) return { identity: resource };
  // A new output may not exist yet. Resolve its existing ancestor so symlinks
  // and /tmp aliases cannot hide overlapping ownership of future outputs.
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try { return { identity: resolve(await realpath(current), ...suffix), ancestor: current }; }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT" || dirname(current) === current) throw error;
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
}
/** Probe existing directory aliases without writing into the user's volume. */
async function isCaseSensitive(ancestor: string): Promise<boolean | undefined> {
  let current = (await stat(ancestor)).isDirectory() ? ancestor : dirname(ancestor);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    const [entry, directory] = await Promise.all([stat(current), stat(parent)]);
    // A mount point's spelling belongs to its parent volume, not its own.
    if (entry.dev !== directory.dev) return undefined;
    const name = basename(current);
    const alternate = name.replace(/[a-zA-Z]/, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    if (alternate !== name) {
      try {
        const alias = await stat(resolve(parent, alternate));
        return entry.dev !== alias.dev || entry.ino !== alias.ino;
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return true;
        throw error;
      }
    }
    current = parent;
  }
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
export async function resourcesOverlap(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [left, right] = await Promise.all([canonicalResource(a), canonicalResource(b)]);
  if (left.identity === right.identity) return true;
  if (!left.ancestor || !right.ancestor) return false;
  if (contains(left.identity, right.identity) || contains(right.identity, left.identity)) return true;
  const lowerLeft = left.identity.toLowerCase(), lowerRight = right.identity.toLowerCase();
  if (!contains(lowerLeft, lowerRight) && !contains(lowerRight, lowerLeft)) return false;
  const sensitivity = await Promise.all([isCaseSensitive(left.ancestor), isCaseSensitive(right.ancestor)]);
  // Unknown volume semantics cannot prove a case-only future output disjoint.
  return !sensitivity.every((sensitive) => sensitive === true);
}
export async function conflictingWorkflowRun(snapshot: ProjectWorkflowSnapshot, resources: string[]): Promise<WorkflowRun | undefined> {
  for (const run of snapshot.runs) {
    if (!["queued", "executing", "paused", "unknown"].includes(run.state) && !run.effects.some((effect) => effect.state === "unknown")) continue;
    const scope = run.effects.filter((effect) => effect.id === "dispatch" || effect.id.startsWith("scope:"));
    for (const effect of scope) for (const resource of resources) {
      if (await resourcesOverlap(resource, effect.resource)) return run;
    }
  }
}
