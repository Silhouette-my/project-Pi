//! Trusted workflow run -> Host turn resource boundary. Model arguments cannot grant scope.
use super::*;
use crate::tools::ToolsExecuteParams;
use std::path::{Path, PathBuf};

fn denied(message: impl Into<String>) -> Error {
    Error::new("WORKFLOW_RESOURCE_DENIED", message)
}

fn root_for(db: &Database, run: &Value) -> Result<PathBuf> {
    let path: Option<String> = db.conn().query_row(
        "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
        params![run["sessionId"].as_str()],
        |r| r.get(0),
    )?;
    let path = match path {
        Some(path) => path,
        None => {
            db.list_project_groups()?
                .into_iter()
                .find(|p| Some(p.id.as_str()) == run["projectId"].as_str())
                .ok_or_else(|| denied("workflow project no longer exists"))?
                .primary_path
        }
    };
    if path.starts_with(crate::db::REMOTE_PROJECT_PREFIX) {
        return Err(denied(
            "remote workflow tools have no local resource containment",
        ));
    }
    crate::workspace::simple_canonicalize(Path::new(&path))
        .map_err(|e| denied(format!("workflow root: {e}")))
}

fn local_reference(reference: &str) -> Option<PathBuf> {
    if reference.starts_with("file:") {
        reqwest::Url::parse(reference).ok()?.to_file_path().ok()
    } else if reference.contains("://") {
        None
    } else {
        Some(PathBuf::from(reference))
    }
}
fn resolve(root: &Path, reference: &str) -> Result<PathBuf> {
    let path = local_reference(reference)
        .ok_or_else(|| denied(format!("resource is not a local file path: {reference}")))?;
    crate::workspace::resolve_external_path(root, &path.to_string_lossy()).map_err(denied)
}

/// Called inside the run.start CAS transaction. Later observations never widen dispatch scope.
pub(super) fn capture_dispatch(db: &Database, run: &Value) -> Result<()> {
    let root = root_for(db, run)?;
    let mut resources = vec![];
    for effect in rows(run, "effects") {
        resources.push(
            json!({"action":effect["action"],"resource":effect["resource"],
            "path":resolve(&root,effect["resource"].as_str().unwrap())?.to_string_lossy()}),
        );
    }
    db.conn().execute(
        "INSERT INTO workflow_run_scopes(run_id,dispatch_json) VALUES(?1,?2)",
        params![
            run["id"].as_str(),
            json!({"root":root.to_string_lossy(),"resources":resources}).to_string()
        ],
    )?;
    Ok(())
}

fn active<'a>(
    db: &Database,
    state: &'a Value,
    session: &str,
    run_id: &str,
) -> Result<(&'a Value, &'a Value)> {
    let run = find(state, "runs", &json!(run_id)).map_err(|_| denied("workflow run not found"))?;
    if run["sessionId"].as_str() != Some(session) {
        return Err(denied("workflow run belongs to another session"));
    }
    check_session_scope(db, &run["sessionId"], &run["projectId"]).map_err(|e| denied(e.message))?;
    let wi = work_index(db, state, run).map_err(|e| denied(e.message))?;
    let work = &state["workstreams"][wi];
    if !["queued", "executing"].contains(&run["state"].as_str().unwrap())
        || !["ready", "executing"].contains(&work["status"].as_str().unwrap())
        || run["decisionRevision"] != work["decisionRevision"]
        || rows(run, "effects")
            .iter()
            .any(|effect| effect["state"] == "unknown")
    {
        return Err(denied(
            "workflow run is no longer active at the current decision",
        ));
    }
    if let Some(link) = rows(state, "conversations")
        .iter()
        .find(|c| c["sessionId"].as_str() == Some(session))
    {
        check_scope(link, run).map_err(|e| denied(e.message))?;
    }
    let auth = find(state, "authorizations", &run["authorizationId"])
        .map_err(|_| denied("workflow authorization missing"))?;
    check_scope(auth, run).map_err(|e| denied(e.message))?;
    if auth["revoked"] != false || auth["source"]["kind"] != "user" {
        return Err(denied(
            "workflow authorization revoked or not user-authorized",
        ));
    }
    if let Some(expiry) = auth.get("expiresAt") {
        let expiry = chrono::DateTime::parse_from_rfc3339(expiry.as_str().unwrap())
            .map_err(|_| denied("invalid authorization expiry"))?;
        if expiry.timestamp_millis() <= now_ms() {
            return Err(denied("workflow authorization expired"));
        }
    }
    Ok((run, auth))
}

pub(crate) fn prepare_binding(db: &Database, session: &str, run_id: &str) -> Result<Value> {
    validation::validate(&json!(run_id), "id").map_err(|e| denied(e.message))?;
    let state = load(db)?;
    let (run, auth) = active(db, &state, session, run_id)?;
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT dispatch_json FROM workflow_run_scopes WHERE run_id=?1",
            params![run_id],
            |r| r.get(0),
        )
        .optional()?;
    let dispatch: Value = serde_json::from_str(&raw.ok_or_else(|| {
        denied("run predates trusted dispatch scope; create a newly authorized run")
    })?)?;
    let mut outputs = vec![];
    for resource in rows(&dispatch, "resources") {
        if !rows(auth, "actions").contains(&resource["action"])
            || !rows(auth, "resources").contains(&resource["resource"])
        {
            return Err(denied(
                "dispatch resource is outside user-authorized assignment",
            ));
        }
        outputs.push(resource["path"].clone());
    }
    let root = Path::new(dispatch["root"].as_str().unwrap());
    let mut inputs = vec![];
    let relevant = |row: &Value| {
        row["projectId"] == run["projectId"]
            && row
                .get("workstreamId")
                .is_none_or(|w| *w == run["workstreamId"])
    };
    let mut add_input = |reference: &str| {
        if let Ok(path) = resolve(root, reference) {
            inputs.push(json!(path.to_string_lossy()));
        }
    };
    for resource in rows(&state, "resources")
        .iter()
        .filter(|r| relevant(r) && r["state"] == "effective")
    {
        add_input(resource["uri"].as_str().unwrap());
    }
    for artifact in rows(&state, "artifacts").iter().filter(|r| relevant(r)) {
        add_input(artifact["entryPoint"].as_str().unwrap());
    }
    for delivery in rows(&state, "deliveries")
        .iter()
        .filter(|r| relevant(r) && r["state"] != "produced")
    {
        for source in rows(delivery, "sources")
            .iter()
            .filter(|s| s["kind"] == "file")
        {
            add_input(source["ref"].as_str().unwrap());
        }
    }
    Ok(json!({"runId":run_id,"root":dispatch["root"],"outputs":outputs,"inputs":inputs}))
}

pub(crate) fn bind(db: &Database, turn: &str, run: &str, scope: &Value) -> Result<()> {
    db.conn().execute(
        "INSERT INTO workflow_turn_bindings(turn_id,run_id,scope_json) VALUES(?1,?2,?3)",
        params![turn, run, scope.to_string()],
    )?;
    Ok(())
}

/// Resolve only persisted Host turn identity. Missing model-supplied turnId never escapes a binding.
pub(crate) fn authorize_tool(
    db: &Database,
    call: &ToolsExecuteParams,
) -> Result<Option<(String, PathBuf)>> {
    let current: Option<(String,Option<String>,Option<String>)> = db.conn().query_row(
        "SELECT t.id,b.run_id,b.scope_json FROM turns t LEFT JOIN workflow_turn_bindings b ON b.turn_id=t.id WHERE t.session_id=?1 AND t.status='running'",
        params![call.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((turn, Some(run), Some(raw))) = current else {
        if let Some(turn) = call.turn_id.as_deref() {
            let bound: bool = db.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_turn_bindings WHERE turn_id=?1)",
                params![turn],
                |r| r.get(0),
            )?;
            if bound {
                return Err(denied(
                    "workflow turn is not the active Host turn for this session",
                ));
            }
        }
        return Ok(None);
    };
    if call.turn_id.as_deref().is_some_and(|id| id != turn) {
        return Err(denied("tool turnId does not match active workflow turn"));
    }
    let state = load(db)?;
    active(db, &state, &call.session_id, &run)?;
    if call.run_in_background
        || call.delegation_id.is_some()
        || !["Write", "Edit", "Read"].contains(&call.tool_name.as_str())
    {
        return Err(denied(format!("{} has no contained workflow executor; use scoped Read/Write/Edit or request a supported execution boundary",call.tool_name)));
    }
    let scope: Value = serde_json::from_str(&raw)?;
    if call.tool_name == "Edit" {
        if let Some(ops) = call.args.get("ops").and_then(Value::as_str) {
            crate::tools::hashline::require_single_target_edit(ops)
                .map_err(|e| denied(e.message))?;
        }
    }
    let path = call
        .args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| denied("scoped file tool requires path"))?;
    let path = resolve(Path::new(scope["root"].as_str().unwrap()), path)?;
    let allowed = rows(&scope, "outputs")
        .iter()
        .chain(if call.tool_name == "Read" {
            rows(&scope, "inputs").iter()
        } else {
            [].iter()
        })
        .any(|root| crate::workspace::path_is_within(Path::new(root.as_str().unwrap()), &path));
    if !allowed {
        return Err(denied(format!(
            "{} requires explicit {} resource scope for {}",
            call.tool_name,
            if call.tool_name == "Read" {
                "read"
            } else {
                "output"
            },
            path.display()
        )));
    }
    Ok(Some((turn, path)))
}

pub(crate) fn denial(call: &ToolsExecuteParams, error: Error) -> Value {
    json!({"toolCallId":call.tool_call_id,"ok":false,"isError":true,"denied":true,"errorCode":error.code,
        "durationMs":0,"content":{"code":error.code,"error":error.message}})
}
