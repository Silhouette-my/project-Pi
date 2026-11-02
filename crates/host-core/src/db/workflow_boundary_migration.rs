#[cfg(test)]
use super::{create_migration_backup, Connection, Context, Path, Result};

pub(crate) const WORKFLOW_BOUNDARY_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_run_scopes (
  run_id TEXT PRIMARY KEY,
  dispatch_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_turn_bindings (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  scope_json TEXT NOT NULL
);
"#;

#[cfg(test)]
pub(crate) fn migrate_v25_to_v26(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 25)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turn_queue') WHERE name='workflow_run_id')",
        [],
        |r| r.get(0),
    )?;
    if !has_column {
        tx.execute_batch("ALTER TABLE turn_queue ADD COLUMN workflow_run_id TEXT;")?;
    }
    // The parallel Chat preview also used v25, without the workflow tables.
    tx.execute_batch(super::PROJECT_WORKFLOW_DDL)?;
    tx.execute_batch(WORKFLOW_BOUNDARY_DDL)?;
    tx.pragma_update(None, "user_version", 26i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v25 to v26 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
