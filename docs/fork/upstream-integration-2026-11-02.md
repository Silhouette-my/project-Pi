# Upstream 0.21.0 integration

## Candidate and compatibility

- Worktree: a dedicated local integration worktree.
- Branch: `integrate/latest-dev-upstream-0.21.0`.
- Actual latest development base: `24d81bb20101b23aff90f297ec08cae340815f23`
  (`feat/workflow-agent-path`, 2026-10-27).
- Upstream: `7763be22d08162f8f82729cd52a78816461daaeb` (`vastsa/PI-Desktop main`).
- Committed as merge `605d3026c` and merged into `development` by `631c39b60`.
  Installation was authorized separately, with complete application/data/profile backup.

## Baseline correction

The first candidate incorrectly used published `development` (`bda061f69`) rather
than the latest local build. The user's 2026-10-27 build came from `24d81bb`, which
contains 98 additional commits after local `main` (`acfc3f818`). The first package
was rejected after installation because it omitted those newer features and
restored the older color icon. This candidate is rebuilt from the actual latest
source, preserving monochrome light/dark icons, normal Agent-backed Workflow
tasks and goal form, current Git Review, archived conversations, project/side-chat
navigation and default-None chat instructions for all providers.

The first installation migrated the Test data directory to schema 28. Database
integrity and identities of 147 sessions, 9 providers, 20 projects and 1 Workflow
record were verified against the pre-upgrade backup, including session presets
and model/permission selections. That backup remains untouched in the local backup directory recorded in the
private workspace notes.
This candidate supports both the original schema27 and already-migrated28 data.

Preserve Project Workflow, project navigation and side conversations, ChatGPT
browser transport and instruction presets, bundled skills, native desktop
refinements, and existing visualization transcripts while incorporating upstream.
The upstream optional GenUI path must not gate the fork's existing visualization
entry points: existing fences and trusted-host-confirmed actions remain usable.

Both source branches call different database layouts schema 27. A shape-aware
convergence migration must preserve their data and produce one schema, including
for fresh databases. The upstream transcript image format also changes. Test on
isolated fixtures; before any later real-data upgrade, stop the application and
back up the **entire data directory**, including SQLite, transcripts, and binary
assets. Rollback restores the matching application and complete pre-upgrade data;
do not point an older application at upgraded data.

## Ownership

- Host owner: Rust conflicts, convergent migration, fixtures, Host tests.
- Runtime owner: runtime/shared contracts, session IPC and launch wiring.
- Visualization owner: GenUI plus legacy rendering, skill selection, frame policy.
- Integrator: renderer configuration/provider flows, docs/changelogs, dependency
  installation, cross-package build and isolated user-path checks.

## Previous candidate evidence

Dependencies require an isolated lockfile install because upstream
changes the Pi engine from 1.3.0 to 1.4.0; the primary dependency tree is not reused
as though compatible. The existing package store/toolchain is reused.

The following ran on the older-based candidate. Only unchanged components reuse
this evidence; latest-baseline validation is recorded separately below:

- JavaScript/workspace build, Desktop typecheck, lint and docs build/check pass.
- Runtime: 1,740 tests; shared: 1,358; host-runtime: 165, all pass.
- Rust: full run passed 1,152 tests with one ignored test and two stale schema-27
  assertion failures. Those assertions now check the opened database against the
  current version; both targeted reruns pass. Migration fixtures additionally
  cover both histories, the chat-only v25 preview, queued workflow bindings,
  restart, failed-transaction rollback/retry and fresh creation. Clippy and
  candidate Host build pass (pre-existing Clippy warnings remain).
- Renderer configuration/command tests pass, including explicit preset reset
  alongside Fast mode. The existing post-create preset configuration API is
  retained; Fast-off uses the new-session Host default.
- Provider Electron user path passes: no-key create/edit, retained/cleared keys,
  synthetic ChatGPT login/challenge/catalog/logout/import and connection results.
- Workflow: 75 renderer/lifecycle tests plus two real-Host cross-process tests
  pass, including side delivery consumption, pause/resume and durable restart.
- Tool-image persistence passes with 95 images / 67,114,080 unique image bytes,
  bounded history mutations, revisions, forks, restart and directory relocation.
  Review-state persistence passes with the default roughly 16 MiB fixture.
- Unified GenUI/legacy Electron interaction and CSP checks pass. Both persisted
  formats, confirmed legacy actions and widget state are preserved. The Skill
  bridge uses the trusted per-session launch context, not model-supplied options
  or a newly changed global setting; real-stdio regression covers this path.
- Actual candidate startup passes: preload/Host IPC, native macOS menu and
  responsive refresh of 800 synthetic sessions. Project Console dark/narrow
  layouts and mixed visualization rendering were visually inspected.

Independent review found the on-demand Skill body mismatch described above; it
was fixed and the actual bridge regression passes. No real accounts, paid APIs,
real user databases, installed-app replacement, Windows/Linux runtime checks or
the optional 384 MiB Review performance fixture were used.

Evidence logs and screenshots were kept in local temporary directories and are
not part of the repository.

## Latest-baseline validation

- Rust: 1172 passed, 0 failed, 1 ignored; release build and Clippy passed.
- Runtime: 1747 passed; shared: 1380 passed.
- Real release-Host Workflow cross-process acceptance: 2 passed.
- host-runtime: 175 passed; focused lifecycle/Skill tests passed.
- Renderer: Desktop types and lint pass; i18n 33, navigation/panel 81 and project
  panel 6 tests pass. Real Electron goal-form/Git Review/archive suites pass.
- Detached side-chat real Electron journey passes: first-send fork, streamed
  response, Summary/All returns to parent draft without sending, None default,
  running-parent guards and child retention. The fixture uses normal panel reveal
  before interacting with a deliberately auto-hidden panel.
- Review retains default working-tree Git changes; history-focus requests select
  and expand Tool history. Project browser restore now uses the presented panel
  context rather than the underlying active session; the regression is covered.
- Workspace build, docs build/check and combined legacy/GenUI E2E pass. Packaged
  native smoke and strict signature verification pass. Package resources contain
  the current release Host, bundled runtime, skills and GenUI vendor resources.

## Installed result

Installed and launched `/Applications/PI-Desktop Test.app`, using the original
native launcher and the same bundle ID, Apple Development signing identity,
data directory and Electron profile. Both the running app and Host display
0.21.0. The package has the latest monochrome light/dark icon assets, not the
older color icon. Actual installed UI exposes default-None chat instructions,
theme colors, panel layout preferences and archived-conversation management.

After installation, schema 28 integrity and all 147 session, 9 provider, 20 project
and 1 Workflow identities, plus existing model/permission/preset selections, match the
pre-correction snapshot. No real model request was sent. The app remains open.

The complete pre-task backup and `RESTORE.md` / `restore.py` are kept in the
local backup directory recorded in the private workspace notes.
The `pre-corrected` subdirectory separately retains data/profile after the first
candidate, so later local state was not discarded. The rejected first bundle is
also retained there and must not be used as the latest development baseline.

This is a local Apple Development-signed build, not a notarized release. The
existing self-build has no update feed (`app-update.yml`); update this fork
manually rather than installing upstream releases over its custom features.

The first symlink-only dependency reuse was rejected by pnpm12's real-directory
checks. A frozen offline install rebuilt only this worktree's dependency links,
reusing the package store and matching Electron binary. It did not change the
lockfile or the earlier worktree's dependencies.

## Try the built candidate without upgrading existing data

From this worktree on macOS, open an empty isolated preview:

```bash
preview=$(mktemp -d /private/tmp/project-pi-preview.XXXXXX)
mkdir -p "$preview/home" "$preview/data" "$preview/profile"
HOME="$preview/home" \
PI_DESKTOP_DATA_DIR="$preview/data" \
PI_DESKTOP_HOST_BIN="$PWD/target/release/pi-desktop-host-core" \
ELECTRON_RENDERER_URL= \
  ./apps/desktop/node_modules/.bin/electron ./apps/desktop \
  --user-data-dir="$preview/profile"
```

The built Host was retained under this worktree's `target/release` after using the
shared Cargo cache, so later builds in other worktrees do not replace this copy.
Electron 43.6.0 is reused from the matching primary installation by reference.
This preview starts empty. Do not point it at daily-use data until the full
backup/recovery procedure above has been completed. Publishing the branch and
replacing the daily-use application remain separate, explicitly authorized steps.
