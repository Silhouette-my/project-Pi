//! Host-boundary validation mirrors the additive shared workflow contract.
//! Field specifications are closed objects, not a general JSON command executor.
use super::{Error, Result};
use serde_json::Value;

fn specification(name: &str) -> Option<&'static str> {
    Some(match name {
        "source" => "kind:user|session|message|file|run ref:id revision?:text",
        "projectAgent" => "projectId:id sessionId:id",
        "acceptance" => "id:id title:id status:pending|satisfied|reopened evidenceIds:ids",
        "owner" => "kind:user|session|agent ref:id",
        "blocker" => "reason:text owner:id resumeWhen:text",
        "workstream" => "id:id projectId:id title:id goal:text acceptance:[acceptance] owner:owner status:draft|ready|executing|paused|blocked|awaiting_user|completed|cancelled priority:int order:number dependencyIds:ids blocker?:blocker nextAction:text currentCandidateId?:id mainSessionId?:id revision:rev decisionRevision:rev createdAt:id updatedAt:id",
        "folder" => "id:id name:id parentId?:id order:number scope?:chats|projects|project projectId?:id categoryId?:id",
        "category" => "id:id name:id order:number",
        "treeTarget" => "kind:folder|session|project id:id",
        "readContext" => "selection?:text resourceIds:ids includeDecisions:bool includeArtifacts:bool",
        "conversation" => "sessionId:id projectId:id workstreamId:id parentSessionId?:id sourceMessageId?:id sourceRevision:rev relation:main|branch|child purpose:ask|explore|work visibility:project|side_only readContext:readContext returnPolicy:none|proposal|delivery archived:bool order:number",
        "resource" => "id:id projectId:id workstreamId?:id label:id uri:id kind:doc|constraint|skill|source revision:text updatedAt:id state:effective|superseded source:source",
        "decision" => "id:id projectId:id workstreamId:id title:id statement:text state:proposed|effective|superseded|dismissed|alternative sources:[source] supersedesId?:id adoptedRevision?:rev adoptedBy?:source createdAt:id",
        "authorization" => "id:id projectId:id workstreamId:id actions:ids resources:ids source:source permissionCeiling:ask|accept-edits|auto maxRuns:positive stopConditions:[text] expiresAt?:id revoked:bool",
        "effect" => "id:id action:id resource:id state:planned|confirmed|unknown|failed detail:text",
        "run" => "id:id projectId:id workstreamId:id sessionId:id executor:id workstreamRevision:rev decisionRevision:rev authorizationId:id state:queued|executing|paused|completed|failed|cancelled|interrupted|unknown outcome:text effects:[effect] startedAt:id updatedAt:id completionKey?:id",
        "artifact" => "id:id projectId:id workstreamId:id runId?:id label:id kind:candidate|report|change|build|test|other revision:id environment:text entryPoint:id source:source supersedesId?:id createdAt:id",
        "evidence" => "id:id projectId:id workstreamId:id candidateId:id candidateRevision:id environment:text scenario:id acceptanceId:id outcome:passed|failed|not_run kind:unit|integration|rendered|live_account|deployment|review limits:text source:source createdAt:id",
        "feedback" => "id:id projectId:id workstreamId:id candidateId:id candidateRevision:id environment:text acceptanceId:id comment:text source:source createdAt:id",
        "delivery" => "id:id projectId:id workstreamId:id sourceRunId:id kind:proposal|evidence|result summary:text artifactIds:ids sources:[source] decisionRevision:rev state:produced|delivered|consumed disposition:pending|integrated|stale|conflict|retained createdAt:id consumedAt?:id",
        "navigation" => "sessionId:id folderId?:id categoryId?:id order:number favorite:bool lastAccessedAt?:id lastMessageId?:id",
        "patch" => "title?:id goal?:text acceptance?:[acceptance] owner?:owner priority?:int order?:number dependencyIds?:ids nextAction?:text blocker?:nullable_blocker currentCandidateId?:nullable_id mainSessionId?:id",
        "query" => "projectId?:id workstreamId?:id",
        "search" => "query:text projectId?:id workstreamId?:id sessionId?:id limit?:limit",
        _ => return None,
    })
}

pub(super) fn validate(value: &Value, name: &str) -> Result<()> {
    let valid = match name {
        "id" => value
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.chars().count() <= 512),
        "text" => value.as_str().is_some_and(|v| v.chars().count() <= 100000),
        "rev" => value.as_u64().is_some_and(|v| v <= i64::MAX as u64),
        "int" => value.as_i64().is_some(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "bool" => value.is_boolean(),
        "positive" => value
            .as_u64()
            .is_some_and(|v| v >= 1 && v <= i64::MAX as u64),
        "limit" => value.as_u64().is_some_and(|v| (1..=500).contains(&v)),
        "ids" => return array(value, "id", Some(1000)),
        n if n.starts_with("nullable_") => {
            return if value.is_null() {
                Ok(())
            } else {
                validate(value, &n[9..])
            }
        }
        n if n.starts_with('[') => return array(value, &n[1..n.len() - 1], None),
        n if n.contains('|') => value.as_str().is_some_and(|v| n.split('|').any(|s| s == v)),
        n => {
            return object(
                value,
                specification(n).ok_or_else(|| Error::invalid("unknown record schema"))?,
            )
        }
    };
    if valid {
        Ok(())
    } else {
        Err(Error::invalid(format!("invalid {name}")))
    }
}

fn array(value: &Value, item: &str, max: Option<usize>) -> Result<()> {
    let values = value
        .as_array()
        .ok_or_else(|| Error::invalid("expected array"))?;
    if max.is_some_and(|max| values.len() > max) {
        return Err(Error::invalid("array too large"));
    }
    for value in values {
        validate(value, item)?;
    }
    Ok(())
}

fn object(value: &Value, fields: &str) -> Result<()> {
    let map = value
        .as_object()
        .ok_or_else(|| Error::invalid("expected object"))?;
    let properties: Vec<_> = fields
        .split_whitespace()
        .map(|f| f.split_once(':').unwrap())
        .collect();
    for key in map.keys() {
        if !properties
            .iter()
            .any(|(name, _)| name.trim_end_matches('?') == key)
        {
            return Err(Error::invalid(format!("unexpected field {key}")));
        }
    }
    for (name, ty) in properties {
        let key = name.trim_end_matches('?');
        match map.get(key) {
            Some(value) => {
                validate(value, ty).map_err(|e| Error::invalid(format!("{key}: {}", e.message)))?
            }
            None if name.ends_with('?') => (),
            None => return Err(Error::invalid(format!("missing {key}"))),
        }
    }
    Ok(())
}

pub(super) fn command(value: &Value) -> Result<()> {
    let kind = value["kind"]
        .as_str()
        .ok_or_else(|| Error::invalid("kind required"))?;
    let fields = match kind {
        "agent.create" => "projectId:id",
        "agent.link" => "agent:projectAgent",
        "folder.create" | "folder.update" => "folder:folder",
        "folder.remove" => "folderId:id",
        "category.create" | "category.update" => "category:category",
        "category.remove" => "categoryId:id",
        "category.reorder" => "categoryIds:ids",
        "navigation.move" => "sessionIds:ids folderId?:id categoryId?:id",
        "navigation.update" => "navigation:navigation",
        "navigation.expand" => "expandedIds:ids",
        "project.favorite" => "projectId:id favorite:bool order?:number",
        "tree.move" => "target:treeTarget scope:chats|projects|project projectId?:id folderId?:id categoryId?:id order:number siblingOrder?:[treeTarget]",
        "workstream.create" => "workstream:workstream",
        "workstream.update" => "projectId:id workstreamId:id patch:patch",
        "conversation.link" => "conversation:conversation",
        "conversation.policy" => "projectId:id workstreamId:id sessionId:id returnPolicy:none|proposal|delivery",
        "conversation.return" => "projectId:id workstreamId:id sessionId:id recordId:id title:id text:text createdAt:id",
        "resource.put" => "resource:resource",
        "decision.propose" => "decision:decision",
        "decision.resolve" => "projectId:id workstreamId:id decisionId:id resolution:adopt|dismiss|alternative source:source",
        "authorization.grant" => "authorization:authorization",
        "authorization.revoke" => "projectId:id workstreamId:id authorizationId:id",
        "artifact.put" => "artifact:artifact",
        "evidence.add" => "evidence:evidence",
        "feedback.add" => "feedback:feedback",
        "workstream.transition" => "projectId:id workstreamId:id status:draft|ready|executing|paused|blocked|awaiting_user|completed|cancelled nextAction:text blocker?:blocker",
        "run.start" => "run:run",
        "run.observe" => "projectId:id workstreamId:id runId:id state:queued|executing|paused|completed|failed|cancelled|interrupted|unknown outcome:text effects:[effect] completionKey?:id",
        "delivery.publish" => "delivery:delivery",
        "delivery.consume" => "projectId:id workstreamId:id deliveryId:id disposition:pending|integrated|stale|conflict|retained",
        _ => return Err(Error::invalid("unsupported workflow command")),
    };
    object(
        value,
        &format!("commandId:id expectedRevision:rev kind:{kind}|{kind} {fields}"),
    )
}
