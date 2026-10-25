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

## Amendment: categories (mixed scopes)

Sidebar organization is now a list of **categories**. The built-in `chats` and
`projects` categories are virtual; user-defined categories live in the
snapshot's optional `categories` collection (`id`, `name`, `order`) and are
managed by `category.create`, `category.update` and `category.remove`. Existing
snapshots load unchanged (`categories` defaults to empty; absent `categoryId`
derives from folder scope, or from the default for rows).

- `chats` and `projects` scope are one **category space**. A category may hold
  folders, standalone conversations and projects in one shared order space.
  The Host no longer rejects sessions in project categories or projects in
  chat-scope folders. `project` scope stays a separate per-project tree, and a
  project's own sessions still cannot be filed in a category.
- Optional `categoryId` is added to folders, `navigation` rows, `projectNavigation`
  rows, `tree.move` and `navigation.move`. A folder's category must equal its
  parent's; `tree.move` restamps a moved folder and its descendants, and an
  entry placed in a folder derives its category from it. `folder.update` cannot
  change a category. Removing a root folder keeps its children in the same
  category.
- `category.remove` deletes no data: folders and conversations move to the
  built-in `chats`, projects to `projects` (a project inside a folder travels with
  that folder).
- Persisted `ProjectMeta.color` and the shared accent presets stay in storage but
  the UI no longer reads or writes a per-project colour; the global theme accent
  remains.
- Interaction changes: folder menus are Rename, New folder, Remove folder (no
  confirmation, never deletes chats); folders move by drag; Favorites left the
  UI (the field is kept); the Project Agent no longer has a sidebar icon.

## Amendment: favourites for projects and project conversations

Favourites return as a sidebar view (a per-window preference in local storage,
not Host data). The persisted flag covers three kinds of row:

- Standalone and project conversations keep the existing `navigation.favorite`
  flag, written by `navigation.update`; a project chat needs no new field.
- `projectNavigation` rows gain an optional `favorite` boolean. Absent means
  false, so snapshots written before this amendment load unchanged and no
  migration or schema bump is needed.
- A new user command `project.favorite { projectId, favorite, order? }` sets the
  flag. The Host validates the project exists and the field types; it creates
  the `projectNavigation` row at the supplied `order` (default 0) when none
  exists, and never alters the placement of an existing row. Rejected commands
  leave the snapshot unchanged. The command is user-only: agents and workflow
  tools cannot star anything.

The earlier note that Favorites left the UI is superseded.

## Amendment: category order

Every category, built-ins included, is draggable. Custom categories already carry
`order`, but the virtual built-ins cannot be edited, so the display order lives in
one optional snapshot field `categoryOrder: string[]` (category ids, built-ins
included) written only by the user command `category.reorder { categoryIds }`.
The Host validates that every id names a category, that ids are unique and that
there are at most 1000. When the field is absent (all existing snapshots) or an
id is missing from it, the default applies: built-ins first, then custom
categories by `order`; ids missing from the list sort after the listed ones.
`category.remove` drops the id from the list. Nothing else changes; the field is
additive, so older snapshots load unchanged.
