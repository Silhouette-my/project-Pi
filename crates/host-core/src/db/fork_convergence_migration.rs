use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// The published fork and upstream independently assigned versions 25–27.
/// Reconcile their actual columns instead of treating the number as provenance.
/// v28 also gates the upstream tool-image envelope from both older readers.
pub(super) fn migrate(conn: &Connection, path: &Path, from: i64) -> Result<()> {
    let backup = create_migration_backup(conn, path, from)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(super::PROJECT_WORKFLOW_DDL)?;
    tx.execute_batch(super::WORKFLOW_BOUNDARY_DDL)?;
    add_column(
        &tx,
        "turn_queue",
        "workflow_run_id",
        "ALTER TABLE turn_queue ADD COLUMN workflow_run_id TEXT;",
    )?;
    add_column(
        &tx,
        "sessions",
        "prompt_preset",
        "ALTER TABLE sessions ADD COLUMN prompt_preset TEXT;",
    )?;
    add_column(
        &tx,
        "sessions",
        "fast_mode",
        "ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0
         CHECK (fast_mode IN (0, 1));",
    )?;
    if add_column(
        &tx,
        "models",
        "discovery_state",
        "ALTER TABLE models ADD COLUMN discovery_state TEXT
         CHECK (discovery_state IN ('published', 'unlisted'));",
    )? {
        // Match upstream's migration without overwriting an existing explicit
        // unlisted state or treating user-created models as discovered ones.
        tx.execute_batch(
            "UPDATE models SET discovery_state = 'published' WHERE source = 'discovered';",
        )?;
    }
    tx.pragma_update(None, "user_version", super::SCHEMA_VERSION)?;
    tx.commit().with_context(|| {
        format!(
            "commit fork/upstream schema v{from} to v28 convergence; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn add_column(tx: &Transaction<'_>, table: &str, column: &str, ddl: &str) -> Result<bool> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch(ddl)?;
    }
    Ok(!exists)
}

#[cfg(test)]
mod tests;
