import type { ProjectGitCommit } from "@pi-desktop/shared";

/** A compact lane layout. Every line connects an actual commit to its parent. */
export function gitGraph(commits: ProjectGitCommit[]) {
  const lanes: string[] = [];
  const columns = new Map<string, number>();
  let width = 1;
  for (const commit of commits) {
    let column = lanes.indexOf(commit.oid);
    if (column < 0) {
      column = lanes.indexOf("");
      if (column < 0) column = lanes.length;
      lanes[column] = commit.oid;
    }
    columns.set(commit.oid, column);
    lanes[column] = "";
    commit.parents.forEach((parent, index) => {
      if (lanes.includes(parent)) return;
      const available = index === 0 && !lanes[column] ? column : lanes.indexOf("");
      lanes[available < 0 ? lanes.length : available] = parent;
    });
    width = Math.max(width, lanes.length, column + 1);
  }
  const rows = new Map(commits.map((commit, index) => [commit.oid, index]));
  return {
    width,
    nodes: commits.map((commit, row) => ({
      commit,
      row,
      column: columns.get(commit.oid)!,
      parents: commit.parents.map((oid) => ({ oid, row: rows.get(oid), column: columns.get(oid) })),
    })),
  };
}
