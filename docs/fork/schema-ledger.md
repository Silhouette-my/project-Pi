# Fork schema ledger

The fork and upstream allocate SQLite schema versions independently, so the same
number can describe different shapes. Record every fork-side schema change here
and check this ledger before each upstream integration.

Current version: **28** (`SCHEMA_VERSION` in `crates/host-core/src/db.rs`).

| Version | Line | Change | Reference |
|---|---|---|---|
| 24 | shared | Last version common to the fork and upstream | — |
| 25–27 | fork | Project Workflow, its durable resource boundary, chat instruction presets | [ADR](../adr/fork-upstream-schema-convergence.md) |
| 25–27 | upstream | Model discovery state, tool-image envelope marker, session Fast switch | [ADR](../adr/fork-upstream-schema-convergence.md) |
| 28 | converged | Shape-aware migration from either v24–v27 line to one schema; fresh databases create the same schema | `605d3026c`, [ADR](../adr/fork-upstream-schema-convergence.md) |

## Rules

- A fork change that adds a schema version appends a row before it is merged into
  `development`, naming the commit and the migration module.
- An upstream integration compares upstream's new versions with the rows above.
  Overlapping numbers require a shape-aware convergence migration to a version
  greater than both lines, never a renumbered or skipped migration.
- Data written by a newer schema is never opened by an older build. Rollback
  restores the previous executable together with the complete data directory.
