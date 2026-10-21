import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { treeFolders, folderDescendants, treePlacement, treeSiblings, dropPosition } = await import("../src/features/project-workflow/navigation-tree-model.ts");
test("scope keeps independent chats, project categories and project chat trees separate", () => {
 const snapshot={folders:[{id:"legacy"},{id:"chat",scope:"chats"},{id:"category",scope:"projects"},{id:"own",scope:"project",projectId:"p"},{id:"other",scope:"project",projectId:"q"}]};
 assert.deepEqual(treeFolders(snapshot,{scope:"chats"}).map(f=>f.id),["legacy","chat"]);
 assert.deepEqual(treeFolders(snapshot,{scope:"project",projectId:"p"}).map(f=>f.id),["own"]);
});
test("folders and leaves interleave, with before/after/inside and root placements", () => {
 const entries=[{kind:"folder",id:"a",order:0},{kind:"project",id:"p",order:1},{kind:"folder",id:"b",order:2},{kind:"project",id:"nested",parentId:"b",order:0}];
 assert.deepEqual(treeSiblings(entries).map(e=>e.id),["a","p","b"]);
 assert.deepEqual(treePlacement(entries,entries[3],entries[1],"before"),{folderId:undefined,order:.5});
 assert.deepEqual(treePlacement(entries,entries[1],entries[2],"inside"),{folderId:"b",order:1});
 assert.deepEqual(treePlacement(entries,entries[3]),{folderId:undefined,order:3});
 assert.equal(dropPosition("folder",.1),"before"); assert.equal(dropPosition("folder",.5),"inside"); assert.equal(dropPosition("folder",.9),"after"); assert.equal(dropPosition("session",.5),"after");
});
test("deep descendants cannot receive their ancestor", () => {
 const entries=[{kind:"folder",id:"a",order:0},{kind:"folder",id:"b",parentId:"a",order:0},{kind:"folder",id:"c",parentId:"b",order:0}];
 assert.equal(treePlacement(entries,entries[0],entries[2],"inside"),null);
 assert.deepEqual([...folderDescendants(entries,"a")],["a","b","c"]);
});

test("project pins and archives retain their ordering buckets with honest drop feedback", () => {
 const entries=[{kind:"project",id:"normal",order:-10},{kind:"project",id:"pinned",rank:-1,order:100},{kind:"folder",id:"category",order:0},{kind:"project",id:"archived",rank:1,order:-100}];
 assert.deepEqual(treeSiblings(entries).map(e=>e.id),["pinned","normal","category","archived"]);
 assert.equal(treePlacement(entries,entries[1],entries[2],"after"),null);
 assert.equal(treePlacement(entries,entries[0],entries[1],"before"),null);
 assert.deepEqual(treePlacement(entries,entries[1],entries[2],"inside"),{folderId:"category",order:0});
});
