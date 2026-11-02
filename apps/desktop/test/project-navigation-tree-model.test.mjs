import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { treeFolders, folderDescendants, treePlacement, treeSiblings, dropPosition, categoryRoot, rootCategoryId, folderCategory } = await import("../src/features/project-workflow/navigation-tree-model.ts");
const { sidebarCategories, categoryLeaves, standaloneSessions, recentOrder } = await import("../src/features/project-workflow/navigation-category-model.ts");
const { projectSessionChildren } = await import("../src/features/project-workflow/navigation-session-children.ts");
test("one category space holds chat and project folders; each project keeps its own tree", () => {
 const snapshot={folders:[{id:"legacy"},{id:"chat",scope:"chats"},{id:"category",scope:"projects"},{id:"own",scope:"project",projectId:"p"},{id:"other",scope:"project",projectId:"q"}]};
 assert.deepEqual(treeFolders(snapshot,{scope:"chats"}).map(f=>f.id),["legacy","chat","category"]);
 assert.deepEqual(treeFolders(snapshot,{scope:"projects"}).map(f=>f.id),["legacy","chat","category"]);
 assert.deepEqual(treeFolders(snapshot,{scope:"project",projectId:"p"}).map(f=>f.id),["own"]);
});
test("legacy folders derive their category from scope; stored ids win", () => {
 assert.equal(folderCategory({id:"a"}),"chats");
 assert.equal(folderCategory({id:"a",scope:"projects"}),"projects");
 assert.equal(folderCategory({id:"a",scope:"chats",categoryId:"k"}),"k");
 assert.equal(rootCategoryId(categoryRoot("k")),"k");
 assert.equal(rootCategoryId("folder-id"),undefined);
});
test("category roots are sibling spaces and accept drops with no target", () => {
 const entries=[{kind:"project",id:"p",parentId:categoryRoot("k"),order:0},{kind:"session",id:"s",parentId:categoryRoot("chats"),order:0}];
 assert.deepEqual(treeSiblings(entries,categoryRoot("k")).map(e=>e.id),["p"]);
 assert.deepEqual(treePlacement(entries,entries[1],undefined,"after",categoryRoot("k")),{folderId:categoryRoot("k"),order:1});
});
test("categories: built-ins first, custom ones in order; leaves land at stored category roots", () => {
 const snapshot={categories:[{id:"b",name:"B",order:2},{id:"a",name:"A",order:1}],folders:[{id:"f",name:"F",scope:"chats",categoryId:"a",order:0}],
  navigation:[{sessionId:"s1",categoryId:"a",order:1,favorite:false},{sessionId:"s2",folderId:"f",order:0,favorite:false},{sessionId:"s3",categoryId:"gone",order:0,favorite:false}],
  projectNavigation:[{projectId:"p1",categoryId:"a",order:2},{projectId:"p2",folderId:"f",order:1}],conversations:[],workstreams:[]};
 assert.deepEqual(sidebarCategories(snapshot,{chats:"Chats",projects:"Projects"}).map(c=>[c.id,c.builtin]),[["chats",true],["projects",true],["a",false],["b",false]]);
 const sessions=[1,2,3,4].map(n=>({id:"s"+n,title:"S"+n,updatedAt:"2026-01-0"+n,createdAt:"2026-01-01"}));
 const leaves=categoryLeaves(snapshot,sessions,[{id:"p1",name:"P1",order:0},{id:"p2",name:"P2",order:0,pinned:true},{id:"p3",name:"P3",order:0}],new Set(["s4"]));
 const at=id=>leaves.find(l=>l.id===id);
 assert.equal(at("s1").parentId,categoryRoot("a"));
 assert.equal(at("s2").parentId,"f");
 assert.equal(at("s3").parentId,categoryRoot("chats"),"a removed category falls back to the built-in");
 assert.equal(at("s4").parentId,categoryRoot("chats"));
 assert.equal(at("s4").rank,-1);
 assert.equal(at("p1").parentId,categoryRoot("a"));
 assert.equal(at("p2").parentId,"f");
 assert.equal(at("p2").rank,-1);
 assert.equal(at("p3").parentId,categoryRoot("projects"));
});
test("standalone sessions exclude project work, agents and linked conversations", () => {
 const snapshot={conversations:[{sessionId:"linked"}],projectAgents:[{projectId:"p",sessionId:"agent"}],workstreams:[{mainSessionId:"main"}]};
 const sessions=["a","linked","agent","main"].map(id=>({id}));
 sessions.push({id:"proj",projectPath:"/x"});
 assert.deepEqual(standaloneSessions(snapshot,sessions).map(s=>s.id),["a"]);
});
test("the Recent group is pinned first, then newest first", () => {
 const order=recentOrder([{id:"old",recency:1},{id:"new",recency:9},{id:"pin",rank:-1,recency:0}]).map(e=>e.id);
 assert.deepEqual(order,["pin","new","old"]);
});
test("branches and child conversations nest under a shown parent; cycles never hide rows", () => {
 const visible=["a","b","c","d","x","y"].map(id=>({id}));
 const conversations=[
  {sessionId:"b",projectId:"p",parentSessionId:"a",relation:"branch"},
  {sessionId:"c",projectId:"p",parentSessionId:"b",relation:"child"},
  {sessionId:"d",projectId:"p",parentSessionId:"missing",relation:"branch"},
  {sessionId:"x",projectId:"p",parentSessionId:"y",relation:"branch"},
  {sessionId:"y",projectId:"p",parentSessionId:"x",relation:"branch"},
  {sessionId:"a",projectId:"p",relation:"main"}];
 const {roots,childrenOf}=projectSessionChildren(conversations,"p",visible);
 assert.deepEqual(roots.map(s=>s.id),["a","d","x"],"a cycle breaks at one member so both rows stay visible");
 assert.deepEqual(childrenOf({id:"x"}).map(s=>s.id),["y"]);
 assert.deepEqual(childrenOf({id:"a"}).map(s=>s.id),["b"]);
 assert.deepEqual(childrenOf({id:"b"}).map(s=>s.id),["c"]);
 assert.ok(roots.some(s=>s.id==="d"),"an orphaned branch stays a root");
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
