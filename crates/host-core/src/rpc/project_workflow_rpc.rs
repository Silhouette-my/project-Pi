use super::{rpc_err, JsonRpcError};
use crate::{db::Database, project_workflow};
use serde_json::{json, Value};

pub(super) fn handle(db: &Database, method: &str, params: &Value) -> Result<Value, JsonRpcError> {
    let result = match method {
        "project.workflow.snapshot" => project_workflow::snapshot(db, params),
        "project.workflow.mutate" => project_workflow::mutate(db, params),
        "project.workflow.search" => project_workflow::search(db, params),
        _ => unreachable!(),
    };
    result.map_err(|error| {
        let mut mapped = rpc_err(if error.code == "INTERNAL" {1000} else {1002},error.message,error.code);
        if let Some(conflict) = error.conflict {
            mapped.data = Some(json!({"errorCode":error.code,"expectedRevision":conflict["expectedRevision"],"actualRevision":conflict["actualRevision"]}));
        }
        mapped
    })
}
