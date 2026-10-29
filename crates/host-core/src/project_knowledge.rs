//! Sourced assistant notes, separate from the user's project-memory collection.
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{now_ms, Database};

pub const NAMESPACE: &str = "projectKnowledge";
pub const MAX_ACTIVE_BYTES: usize = 16 * 1024;
const MAX_STORED_BYTES: usize = 1024 * 1024;
const MAX_ACTIVE_ENTRIES: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub session_id: String,
    pub message_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub status: String,
    pub source: Source,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub version: u8,
    pub project_id: String,
    pub revision: i64,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteInput {
    pub action: String,
    pub expected_project_id: String,
    pub expected_revision: i64,
    pub entry_id: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
}

pub fn get(db: &Database, project_id: &str) -> Result<Snapshot> {
    if !db
        .list_project_groups()?
        .iter()
        .any(|group| group.id == project_id)
    {
        return Err(anyhow!("NOT_FOUND: project not found"));
    }
    read(db, project_id)
}

fn read(db: &Database, project_id: &str) -> Result<Snapshot> {
    let Some(value) = db.kv_get(NAMESPACE, project_id)? else {
        return Ok(Snapshot {
            version: 1,
            project_id: project_id.into(),
            revision: 0,
            entries: vec![],
        });
    };
    let snapshot: Snapshot = serde_json::from_value(value)?;
    if snapshot.version != 1 || snapshot.project_id != project_id {
        return Err(anyhow!("invalid project knowledge version or identity"));
    }
    Ok(snapshot)
}

pub fn delete_legacy_path(db: &Database, path: &str) -> Result<()> {
    let path =
        crate::db::canonical_project_path(path).ok_or_else(|| anyhow!("project path required"))?;
    db.kv_delete(NAMESPACE, &format!("legacy:{path}"))
}

pub fn for_session(db: &Database, session_id: &str) -> Result<Snapshot> {
    let path: Option<String> = db.conn().query_row(
        "SELECT p.path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1 AND s.deleted_at IS NULL",
        params![session_id], |row| row.get(0)).optional()?;
    let path = path.ok_or_else(|| anyhow!("NOT_FOUND: session has no project"))?;
    let group = db
        .project_group_for_path(&path)?
        .ok_or_else(|| anyhow!("NOT_FOUND: project not found"))?;
    read(db, &group.id)
}

/// Session, turn and source are transport-owned. Never accept them in model args.
pub fn write_for_turn(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    input: &WriteInput,
) -> Result<Snapshot> {
    let tx = db.conn().unchecked_transaction()?;
    let turn_id =
        turn_id.ok_or_else(|| anyhow!("TOOL_TURN_CANCELLED: a running turn is required"))?;
    let running: Option<String> = db.conn().query_row(
        "SELECT s.mode FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=?1 AND t.session_id=?2 AND t.status='running' AND s.deleted_at IS NULL",
        params![turn_id,session_id], |row| row.get(0)).optional()?;
    if running.as_deref() != Some("agent") {
        return Err(anyhow!("TOOL_DENIED: a running Agent turn is required"));
    }
    let message_id: Option<String> = db.conn().query_row(
        "SELECT id FROM messages WHERE session_id=?1 AND turn_id=?2 ORDER BY CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END, seq DESC LIMIT 1",
        params![session_id,turn_id], |row| row.get(0)).optional()?;
    let source = Source { session_id: session_id.into(), turn_id: turn_id.into(),
        message_id: message_id.ok_or_else(|| anyhow!("INVALID_ARGUMENT: persist a source message in this turn before recording knowledge"))? };
    let mut snapshot = for_session(db, session_id)?;
    apply(&mut snapshot, input, Some(source))?;
    save(db, &snapshot, input.action != "forget")?;
    tx.commit()?;
    Ok(snapshot)
}

pub fn forget(
    db: &Database,
    project_id: &str,
    entry_id: &str,
    expected_revision: i64,
) -> Result<Snapshot> {
    let tx = db.conn().unchecked_transaction()?;
    let mut snapshot = get(db, project_id)?;
    apply(
        &mut snapshot,
        &WriteInput {
            action: "forget".into(),
            expected_project_id: project_id.into(),
            expected_revision,
            entry_id: Some(entry_id.into()),
            kind: None,
            title: None,
            content: None,
        },
        None,
    )?;
    save(db, &snapshot, false)?;
    tx.commit()?;
    Ok(snapshot)
}

/// Explicit user operation; model tools cannot discard history automatically.
pub fn clear_history(db: &Database, project_id: &str, expected_revision: i64) -> Result<Snapshot> {
    let tx = db.conn().unchecked_transaction()?;
    let mut snapshot = get(db, project_id)?;
    if snapshot.revision != expected_revision {
        return Err(anyhow!(
            "CONFLICT: project knowledge changed; reload before clearing history"
        ));
    }
    snapshot.entries.retain(|entry| entry.status == "active");
    snapshot.revision += 1;
    save(db, &snapshot, false)?;
    tx.commit()?;
    Ok(snapshot)
}

fn apply(snapshot: &mut Snapshot, input: &WriteInput, source: Option<Source>) -> Result<()> {
    if input.expected_project_id != snapshot.project_id
        || input.expected_revision != snapshot.revision
    {
        return Err(anyhow!(
            "CONFLICT: project knowledge changed; read the latest revision before updating"
        ));
    }
    if !["remember", "replace", "forget"].contains(&input.action.as_str()) {
        return Err(anyhow!(
            "INVALID_ARGUMENT: action must be remember, replace, or forget"
        ));
    }
    let now = now_ms();
    let target = match input.action.as_str() {
        "remember" => {
            if input.entry_id.is_some() {
                return Err(anyhow!(
                    "INVALID_ARGUMENT: remember does not accept entryId"
                ));
            }
            None
        }
        _ => {
            let id = input
                .entry_id
                .as_deref()
                .ok_or_else(|| anyhow!("INVALID_ARGUMENT: entryId required"))?;
            let index = snapshot
                .entries
                .iter()
                .position(|entry| entry.id == id && entry.status == "active")
                .ok_or_else(|| anyhow!("NOT_FOUND: active project knowledge entry not found"))?;
            Some(index)
        }
    };
    if input.action == "forget" {
        if input.kind.is_some() || input.title.is_some() || input.content.is_some() {
            return Err(anyhow!(
                "INVALID_ARGUMENT: forget accepts only entryId and expectedRevision"
            ));
        }
        let entry = &mut snapshot.entries[target.ok_or_else(|| anyhow!("entryId required"))?];
        entry.status = "forgotten".into();
        entry.updated_at = now;
    } else {
        let kind = input
            .kind
            .as_deref()
            .ok_or_else(|| anyhow!("INVALID_ARGUMENT: kind required"))?;
        if !["state", "decision", "knowledge"].contains(&kind) {
            return Err(anyhow!("INVALID_ARGUMENT: invalid knowledge kind"));
        }
        let title = bounded_text(input.title.as_deref(), "title", 640)?;
        if title.chars().count() > 160 {
            return Err(anyhow!("INVALID_ARGUMENT: title exceeds 160 characters"));
        }
        let content = bounded_text(input.content.as_deref(), "content", 4096)?;
        let supersedes_id = target.map(|index| {
            let entry = &mut snapshot.entries[index];
            entry.status = "superseded".into();
            entry.updated_at = now;
            entry.id.clone()
        });
        snapshot.entries.push(Entry {
            id: Uuid::new_v4().to_string(),
            kind: kind.into(),
            title: title.into(),
            content: content.into(),
            status: "active".into(),
            source: source.ok_or_else(|| anyhow!("source required"))?,
            created_at: now,
            updated_at: now,
            supersedes_id,
        });
    }
    validate_active(snapshot)?;
    snapshot.revision += 1;
    Ok(())
}

fn validate_active(snapshot: &Snapshot) -> Result<()> {
    let active: Vec<_> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.status == "active")
        .collect();
    let active_bytes: usize = active
        .iter()
        .map(|entry| entry.title.len() + entry.content.len())
        .sum();
    if active.len() > MAX_ACTIVE_ENTRIES || active_bytes > MAX_ACTIVE_BYTES {
        return Err(anyhow!("PROJECT_KNOWLEDGE_LIMIT: at most 40 active notes and 16384 active text bytes; consolidate or forget obsolete notes"));
    }
    Ok(())
}

/// Called inside the existing group mutation's transaction. Adopt legacy-root
/// notes once, preserving their source and history, before changing identity.
pub fn adopt_legacy_roots(db: &Database, project_id: &str, paths: &[String]) -> Result<()> {
    let mut merged = read(db, project_id)?;
    let mut adopted = vec![];
    for path in paths {
        let key = format!("legacy:{path}");
        if key == project_id || db.kv_get(NAMESPACE, &key)?.is_none() {
            continue;
        }
        let legacy = read(db, &key)?;
        merged.entries.extend(legacy.entries);
        adopted.push(key);
    }
    if adopted.is_empty() {
        return Ok(());
    }
    validate_active(&merged)?;
    merged.revision += 1;
    save(db, &merged, true)?;
    for key in adopted {
        db.kv_delete(NAMESPACE, &key)?;
    }
    Ok(())
}

fn bounded_text<'a>(value: Option<&'a str>, name: &str, max: usize) -> Result<&'a str> {
    let text = value
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: {name} required"))?
        .trim();
    if text.is_empty() || text.contains('\0') || text.len() > max {
        return Err(anyhow!(
            "INVALID_ARGUMENT: {name} must be nonempty, contain no NUL, and fit {max} bytes"
        ));
    }
    Ok(text)
}

fn save(db: &Database, snapshot: &Snapshot, enforce_history_limit: bool) -> Result<()> {
    let value = serde_json::to_value(snapshot)?;
    if enforce_history_limit && serde_json::to_vec(&value)?.len() > MAX_STORED_BYTES {
        return Err(anyhow!("PROJECT_KNOWLEDGE_LIMIT: project knowledge history exceeds 1 MiB; use Clear history in Project memory to remove retired notes, then retry"));
    }
    db.kv_set(NAMESPACE, &snapshot.project_id, &value)
}

pub fn filtered(mut snapshot: Snapshot, query: Option<&str>, include_history: bool) -> Snapshot {
    let query = query.unwrap_or("").to_lowercase();
    snapshot.entries.retain(|entry| {
        (include_history || entry.status == "active")
            && (query.is_empty()
                || format!("{}\n{}", entry.title, entry.content)
                    .to_lowercase()
                    .contains(&query))
    });
    snapshot
}

#[cfg(test)]
mod tests;
