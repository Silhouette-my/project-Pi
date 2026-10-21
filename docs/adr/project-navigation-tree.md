# Project navigation trees

## Decision

Navigation organization remains Host-owned workflow metadata. Folders gain optional
`scope` (`chats`, `projects`, or `project`) and `projectId`; omitted scope means
standalone chats. Only project-chat folders carry a project ID. The optional
`projectNavigation` collection places existing stable ProjectGroup IDs. Old v1
snapshots remain readable without a database migration.

`tree.move` atomically sets one folder, project, or session placement and order
through the existing revision CAS and command ledger. Optional `siblingOrder`
normalizes mixed siblings in that transaction, so legacy equal or absent orders
do not make a drop ambiguous. Siblings share one numeric
order space, allowing folders and entries to interleave. The Host rejects cycles,
cross-scope folder moves and sessions outside the selected project. Explicit
conversation links and workstream main sessions retain project membership even
without a workspace. Recent/Favorites share canonical tree drag sources. Navigation
never changes a session workspace, execution root, context or permissions.
Deleting a folder promotes its direct contents to its parent without deleting
sessions or projects. Existing explicit cross-project session operations retain
their original contract.

## Interaction

Project Agent is an icon action on the project title, project Home row, and the
project-aware top bar; these reuse the same canonical discussion and request
state. It has no dedicated navigation row. Project conversations are directly
reachable, without a fixed history wrapper. Organizing is drag-only with no mode toggle:
folder and session rows expose a hover/focus `...` menu (Rename, Move to...,
Remove folder, Move to folder..., Favorites) and one folder dialog for create,
rename and move, so every move stays keyboard-accessible alongside drag-before,
drag-after and drop-inside affordances.
Project pin/archive filtering remains owned by Sidebar.

## Deferred

Git trees, Archify architecture and session relationship trees belong to a later
project overview iteration. This change adds no empty panels for them.
