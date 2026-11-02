# ADR: Fork and upstream schema convergence

- Status: Accepted for the 0.21.0 integration candidate

## Context

The published development fork and upstream share SQLite schema v24, but
independently allocated v25–v27. The fork added Project Workflow, its durable
resource boundary, and chat instruction presets. Upstream added model discovery
state, the storage-private tool-image envelope marker, and the session Fast
switch. A version-27 database therefore does not identify its complete schema.

Running either previous application against the other line's database can skip
required migrations. In addition, the fork's previous version 27 is numerically
newer than upstream's tool-image format marker despite lacking its reader.

## Decision

Use schema **28** as the first unified version. After the shared migration chain
reaches v24, migrate any v24–v27 database directly to v28 in one transaction.
Probe the known divergent table/column inventory at this persisted-data
boundary; add only missing columns and tables. Preserve existing Workflow rows,
queued run bindings, preset values, Fast preferences, and model discovery state.
When adding model discovery state, mark only existing `discovered` models as
`published`, matching upstream's migration; user-created models stay unknown.

Fresh databases create the same combined schema. Both session configurator
entry points retain their original argument contracts: updating a chat preset
does not reset Fast mode, and updating Fast mode does not reset the preset.
The RPC configurator applies both preferences atomically.

Before changing the database, retain the existing versioned SQLite backup
mechanism and its integrity check. A failed convergence rolls back its DDL and
version stamp. Opening v28 again does not rerun the migration or replace its
pre-upgrade backup. Old applications reject v28 before using the new storage
format.

## Validation and recovery

Migration fixtures cover both historical shapes at versions 24–27, preserved
values, fresh creation, a second open, a transaction failure/retry, and rejection
of newer unknown versions. Existing transcript bytes are not converted during
database startup.

Run application acceptance with a separate data directory. Before upgrading a
daily-use installation, close it and back up the **entire data directory**,
including SQLite, transcripts, revisions, in-flight files, and binary assets.
SQLite migration backups alone are not a rollback for tool-image files written
by the new application. To roll back, close the candidate and restore that
complete pre-upgrade directory together with the previous executable. Never run
the old and new versions concurrently against one data directory.

## Consequences

The fork retains its product features while accepting upstream storage and
session capabilities. Future migrations extend v28 rather than reusing either
line's v25–v27 allocation. This integration does not downgrade data or supply a
reverse migration.
