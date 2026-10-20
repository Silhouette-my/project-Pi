use super::{create_migration_backup, Connection, Context, Path, Result};

/// A single aggregate gives workflow commands one atomic, global CAS boundary.
/// Canonical projects, sessions and messages remain in their existing tables.
pub(crate) const PROJECT_WORKFLOW_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS project_workflow (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  format_version INTEGER NOT NULL CHECK(format_version = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_workflow_commands (
  command_id TEXT PRIMARY KEY,
  command_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
"#;

pub(crate) fn migrate_v24_to_v25(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(PROJECT_WORKFLOW_DDL)?;
    tx.pragma_update(None, "user_version", 25i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v24 to v25 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
