//! Durable, host-owned project workflow state. Execution remains in Node runtime.
mod commands;
mod search;
#[cfg(test)]
mod tests;
pub(crate) mod tool_scope;
mod validation;

use crate::db::{now_ms, Database};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub conflict: Option<Value>,
}
impl Error {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            conflict: None,
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message)
    }
    fn missing(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self::new("CONFLICT", message)
    }
    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new("UNAUTHORIZED", message)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("INTERNAL", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("INTERNAL", e.to_string())
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Self::new("INTERNAL", e.to_string())
    }
}

fn empty() -> Value {
    json!({"schemaVersion":1,"revision":0,"folders":[],"navigation":[],"expandedIds":[],
        "workstreams":[],"conversations":[],"resources":[],"decisions":[],"authorizations":[],
        "runs":[],"artifacts":[],"evidence":[],"feedback":[],"deliveries":[]})
}

fn load(db: &Database) -> Result<Value> {
    let row: Option<(i64, i64, String)> = db
        .conn()
        .query_row(
            "SELECT format_version, revision, snapshot_json FROM project_workflow WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(empty()),
        Some((1, revision, raw)) => {
            let value: Value = serde_json::from_str(&raw)?;
            if value["revision"].as_i64() != Some(revision) || value["schemaVersion"] != 1 {
                return Err(Error::new(
                    "INTERNAL",
                    "workflow aggregate revision/version mismatch",
                ));
            }
            Ok(value)
        }
        Some(_) => Err(Error::new("INTERNAL", "unsupported workflow format")),
    }
}

pub fn snapshot(db: &Database, query: &Value) -> Result<Value> {
    validation::validate(query, "query")?;
    let mut value = load(db)?;
    let query = check_query(db, &value, query)?;
    if query.get("projectId").is_some() || query.get("workstreamId").is_some() {
        for key in [
            "workstreams",
            "conversations",
            "resources",
            "decisions",
            "authorizations",
            "runs",
            "artifacts",
            "evidence",
            "feedback",
            "deliveries",
        ] {
            value[key]
                .as_array_mut()
                .unwrap()
                .retain(|row| scoped(row, &query));
        }
    }
    Ok(value)
}

fn scoped(row: &Value, query: &Value) -> bool {
    query
        .get("projectId")
        .is_none_or(|id| row.get("projectId") == Some(id))
        && query.get("workstreamId").is_none_or(|id| {
            row.get("workstreamId").or_else(|| row.get("id")) == Some(id)
                // Project-scoped resources remain visible for workstream context.
                || (row.get("workstreamId").is_none() && row.get("uri").is_some())
        })
}

fn check_query(db: &Database, value: &Value, query: &Value) -> Result<Value> {
    let mut resolved = query.clone();
    if let Some(id) = query.get("workstreamId") {
        let work = find(value, "workstreams", id)?;
        if query
            .get("projectId")
            .is_some_and(|p| work["projectId"] != *p)
        {
            return Err(Error::missing("workstream outside project"));
        }
        resolved["projectId"] = work["projectId"].clone();
    }
    if let Some(project) = resolved.get("projectId") {
        check_project(db, project)?;
    }
    Ok(resolved)
}

pub fn mutate(db: &Database, command: &Value) -> Result<Value> {
    validation::command(command)?;
    let serialized = serde_json::to_string(command)?;
    let tx = rusqlite::Transaction::new_unchecked(db.conn(), TransactionBehavior::Immediate)?;
    let prior: Option<(String, String)> = tx
        .query_row(
            "SELECT command_json, result_json FROM project_workflow_commands WHERE command_id=?1",
            params![command["commandId"].as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((original, _result)) = prior {
        if original != serialized {
            return Err(Error::conflict(
                "commandId already used for another command",
            ));
        }
        // Replay acknowledges the original command, but consumers reconstruct
        // from current authoritative state rather than its historical result.
        let result = json!({"snapshot":load(db)?,"replayed":true});
        tx.commit()?;
        return Ok(result);
    }
    let mut value = load(db)?;
    let expected = command["expectedRevision"].as_u64().unwrap();
    let actual = value["revision"].as_u64().unwrap();
    if expected != actual {
        let mut error = Error::conflict("workflow revision changed; refresh before retrying");
        error.conflict = Some(json!({"expectedRevision":expected,"actualRevision":actual}));
        return Err(error);
    }
    commands::apply(db, &mut value, command)?;
    let next_revision = actual
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| Error::conflict("revision exhausted"))?;
    value["revision"] = json!(next_revision);
    let result = json!({"snapshot":value,"replayed":false});
    tx.execute("INSERT INTO project_workflow(id,format_version,revision,snapshot_json) VALUES(1,1,?1,?2)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot_json=excluded.snapshot_json",
        params![next_revision as i64, result["snapshot"].to_string()])?;
    tx.execute("INSERT INTO project_workflow_commands(command_id,command_json,result_json,revision,created_at)
        VALUES(?1,?2,?3,?4,?5)", params![command["commandId"].as_str(),serialized,result.to_string(),next_revision as i64,now_ms()])?;
    tx.commit()?;
    Ok(result)
}

fn rows<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    value[key].as_array().unwrap()
}
fn rows_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    value[key].as_array_mut().unwrap()
}
fn find<'a>(value: &'a Value, key: &str, id: &Value) -> Result<&'a Value> {
    rows(value, key)
        .iter()
        .find(|row| row["id"] == *id)
        .ok_or_else(|| Error::missing(format!("{key} record not found")))
}
fn index(value: &Value, key: &str, id: &Value) -> Result<usize> {
    rows(value, key)
        .iter()
        .position(|row| row["id"] == *id)
        .ok_or_else(|| Error::missing(format!("{key} record not found")))
}
fn insert(value: &mut Value, key: &str, row: Value) -> Result<()> {
    if rows(value, key).iter().any(|old| old["id"] == row["id"]) {
        return Err(Error::conflict(format!("{key} identity already exists")));
    }
    rows_mut(value, key).push(row);
    Ok(())
}
fn check_project(db: &Database, id: &Value) -> Result<()> {
    if !db
        .list_project_groups()?
        .iter()
        .any(|p| Some(p.id.as_str()) == id.as_str())
    {
        return Err(Error::missing("ProjectGroup not found"));
    }
    Ok(())
}
fn check_session(db: &Database, id: &Value) -> Result<()> {
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        params![id.as_str()],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error::missing("session not found"));
    }
    Ok(())
}
fn check_message(db: &Database, id: &Value, session: &Value) -> Result<()> {
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND session_id=?2)",
        params![id.as_str(), session.as_str()],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(Error::missing("message not found in source session"));
    }
    Ok(())
}
fn check_session_scope(db: &Database, session: &Value, project: &Value) -> Result<()> {
    check_session(db, session)?;
    let path: Option<String> = db.conn().query_row(
        "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
        params![session.as_str()],
        |r| r.get(0),
    )?;
    if let Some(path) = path {
        let group = db
            .list_project_groups()?
            .into_iter()
            .find(|p| Some(p.id.as_str()) == project.as_str())
            .ok_or_else(|| Error::missing("ProjectGroup not found"))?;
        if !group.roots.iter().any(|root| root.path == path) {
            return Err(Error::invalid("session workspace is outside ProjectGroup"));
        }
    }
    Ok(())
}
fn work_index(db: &Database, value: &Value, scope: &Value) -> Result<usize> {
    check_project(db, &scope["projectId"])?;
    let i = index(value, "workstreams", &scope["workstreamId"])?;
    if value["workstreams"][i]["projectId"] != scope["projectId"] {
        return Err(Error::missing("workstream outside project"));
    }
    Ok(i)
}
fn check_scope(row: &Value, scope: &Value) -> Result<()> {
    if row["projectId"] != scope["projectId"] || row["workstreamId"] != scope["workstreamId"] {
        return Err(Error::invalid("reference outside workstream"));
    }
    Ok(())
}
pub fn search(db: &Database, request: &Value) -> Result<Value> {
    search::search(db, request)
}
