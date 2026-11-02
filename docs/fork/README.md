# Fork maintenance records

This directory holds records specific to the `Silhouette-my/project-Pi` fork.
They are not part of upstream `vastsa/PI-Desktop` and are not synchronized back.

## Workflow summary

- Development happens only on this fork. The long-lived baseline branch is
  `development`; local `main` mirrors upstream and receives no fork commits.
- Task branches start from `development` and return to it through a validated
  `--no-ff` merge. `development` is never rebased or force-pushed.
- Upstream changes enter only through an `integrate/upstream-<version>` branch
  that is validated and then merged into `development`.
- Fork builds use the version `<upstream version>-dev<N>`, for example
  `0.21.0-dev1`. An installed build must come from a committed revision on
  `development`.
- Fork tags are the bare version without a `v` prefix (`0.21.0-dev1`). The
  inherited `release.yml` builds and publishes a GitHub Release for every pushed
  `v*.*.*` tag, which this fork does not want.
- The root `AGENTS.md` / `CLAUDE.md` stay as inherited from upstream to keep
  upstream merges clean. Their quality, architecture, testing, and security rules
  apply; their `origin/main` base, `check:pr-base`, and upstream PR steps do not.

## Records

| Record | Purpose |
|---|---|
| [Schema ledger](schema-ledger.md) | Fork-side database schema allocations and convergence points |
| [Upstream 0.21.0 integration](upstream-integration-2026-11-02.md) | Baseline correction, conflict handling, validation, and installation for the 0.21.0 merge |

Add one record per upstream integration and update the schema ledger whenever a
fork change touches persisted data.
