use std::sync::Arc;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::project_knowledge::{self, WriteInput};
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};

pub fn error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let code = match message.split_once(':').map(|(code, _)| code) {
        Some("CONFLICT") => "CONFLICT",
        Some("NOT_FOUND") => "NOT_FOUND",
        Some("INVALID_ARGUMENT") => "INVALID_ARGUMENT",
        Some("TOOL_DENIED") => "TOOL_DENIED",
        Some("TOOL_TURN_CANCELLED") => "TOOL_TURN_CANCELLED",
        Some("PROJECT_KNOWLEDGE_LIMIT") => "PROJECT_KNOWLEDGE_LIMIT",
        _ => "INTERNAL",
    };
    rpc_err(if code == "INTERNAL" { 1000 } else { 1002 }, message, code)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    query: Option<String>,
    #[serde(default)]
    include_history: bool,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

pub async fn execute(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
    started: Instant,
) -> Result<ToolsExecuteResult, JsonRpcError> {
    let st = state.lock().await;
    let authority = crate::project_workflow::tool_scope::authorize_tool(&st.db, p);
    let result = if let Err(failure) = authority {
        Err(anyhow::anyhow!("TOOL_DENIED: {}", failure.message))
    } else if p.permission_scope.is_some() {
        Err(anyhow::anyhow!(
            "TOOL_DENIED: delegated calls cannot maintain the parent session's project knowledge"
        ))
    } else if p.tool_name == "ProjectKnowledgeRead" {
        match serde_json::from_value::<ReadInput>(p.args.clone()) {
            Ok(input)
                if input.query.as_ref().is_none_or(|query| query.len() <= 512)
                    && input.limit.is_none_or(|limit| (1..=40).contains(&limit)) =>
            {
                project_knowledge::for_session(&st.db, &p.session_id).and_then(|snapshot| {
                    let mut snapshot = project_knowledge::filtered(
                        snapshot,
                        input.query.as_deref(),
                        input.include_history,
                    );
                    snapshot.entries.reverse();
                    let limit = input.limit.unwrap_or(20);
                    let has_more = snapshot.entries.len().saturating_sub(input.offset) > limit;
                    snapshot.entries = snapshot
                        .entries
                        .into_iter()
                        .skip(input.offset)
                        .take(limit)
                        .collect();
                    let mut value = serde_json::to_value(snapshot)?;
                    value["hasMore"] = json!(has_more);
                    value["offset"] = json!(input.offset);
                    Ok(value)
                })
            }
            Ok(_) => Err(anyhow::anyhow!("INVALID_ARGUMENT: query exceeds 512 bytes")),
            Err(error) => Err(anyhow::anyhow!("INVALID_ARGUMENT: {error}")),
        }
    } else {
        match serde_json::from_value::<WriteInput>(p.args.clone()) {
            Ok(input) => project_knowledge::write_for_turn(
                &st.db,
                &p.session_id,
                p.turn_id.as_deref(),
                &input,
            )
            .and_then(|snapshot| {
                Ok(serde_json::to_value(project_knowledge::filtered(
                    snapshot, None, false,
                ))?)
            }),
            Err(error) => Err(anyhow::anyhow!("INVALID_ARGUMENT: {error}")),
        }
    };
    let (ok, content, code) = match result {
        Ok(content) => (true, content, None),
        Err(failure) => {
            let failure = error(failure);
            let code = failure
                .data
                .as_ref()
                .and_then(|data| data.get("errorCode"))
                .and_then(Value::as_str)
                .unwrap_or("INTERNAL")
                .to_string();
            (
                false,
                json!({"text":failure.message,"errorCode":code}),
                Some(code),
            )
        }
    };
    Ok(ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: code,
        command_shell_id: None,
    })
}
