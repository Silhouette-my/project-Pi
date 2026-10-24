use super::*;
mod execution;
mod navigation_tree;
mod organization;

pub(super) fn apply(db: &Database, value: &mut Value, command: &Value) -> Result<()> {
    // Every reference enters through this boundary; navigation never changes workspace roots.
    check_sources(db, value, command)?;
    match command["kind"].as_str().unwrap() {
        "tree.move" => navigation_tree::move_entry(db, value, command),
        "agent.create" => {
            let project = db
                .list_project_groups()?
                .into_iter()
                .find(|project| Some(project.id.as_str()) == command["projectId"].as_str())
                .ok_or_else(|| Error::missing("ProjectGroup not found"))?;
            if project.remote.is_some() {
                return Err(Error::invalid(
                    "Project Agent currently requires a local project",
                ));
            }
            if value.get("projectAgents").is_none() {
                value["projectAgents"] = json!([]);
            }
            if rows(value, "projectAgents").iter().any(|agent| {
                agent["projectId"] == command["projectId"]
                    && check_session(db, &agent["sessionId"]).is_ok()
            }) {
                return Ok(());
            }
            // mutate() already owns an IMMEDIATE CAS transaction. Session
            // metadata and its discussion boundary commit together; no ordinary
            // session is observable if creation/linking or persistence fails.
            let session = crate::sessions::create_session(
                db,
                Some(project.name),
                Some("plan".into()),
                None,
                None,
                Some(project.primary_path),
            )?;
            apply(
                db,
                value,
                &json!({"kind":"agent.link", "agent":{"projectId":command["projectId"],"sessionId":session.id}}),
            )
        }
        "agent.link" => {
            let agent = &command["agent"];
            check_project(db, &agent["projectId"])?;
            check_session_scope(db, &agent["sessionId"], &agent["projectId"])?;
            if value.get("projectAgents").is_none() {
                value["projectAgents"] = json!([]);
            }
            if rows(value, "conversations")
                .iter()
                .any(|row| row["sessionId"] == agent["sessionId"])
                || rows(value, "runs")
                    .iter()
                    .any(|row| row["sessionId"] == agent["sessionId"])
            {
                return Err(Error::conflict(
                    "execution sessions cannot become project Agents",
                ));
            }
            if let Some(i) = rows(value, "projectAgents")
                .iter()
                .position(|row| row["projectId"] == agent["projectId"])
            {
                if value["projectAgents"][i] == *agent {
                    return Ok(());
                }
                if check_session(db, &value["projectAgents"][i]["sessionId"]).is_ok() {
                    return Err(Error::conflict("project already has a live Agent session"));
                }
                value["projectAgents"][i] = agent.clone();
            } else {
                if rows(value, "projectAgents")
                    .iter()
                    .any(|row| row["sessionId"] == agent["sessionId"])
                {
                    return Err(Error::conflict("Agent session belongs to another project"));
                }
                rows_mut(value, "projectAgents").push(agent.clone());
            }
            Ok(())
        }
        "folder.create"
        | "folder.update"
        | "folder.remove"
        | "category.create"
        | "category.update"
        | "category.remove"
        | "navigation.move"
        | "navigation.update"
        | "navigation.expand"
        | "conversation.link"
        | "conversation.policy"
        | "conversation.return" => organization::apply(db, value, command),
        "run.start"
        | "run.observe"
        | "delivery.publish"
        | "delivery.consume"
        | "workstream.transition" => execution::apply(db, value, command),
        "workstream.create" => {
            let mut work = command["workstream"].clone();
            check_project(db, &work["projectId"])?;
            if work["revision"] != 0
                || work["decisionRevision"] != 0
                || !["draft", "ready"].contains(&work["status"].as_str().unwrap())
            {
                return Err(Error::invalid(
                    "new workstream requires draft/ready state and revision zero",
                ));
            }
            validate_work(db, value, &work)?;
            work["createdAt"] = json!(crate::db::ms_to_ts(now_ms()));
            work["updatedAt"] = work["createdAt"].clone();
            insert(value, "workstreams", work)
        }
        "workstream.update" => {
            let i = work_index(db, value, command)?;
            let mut work = value["workstreams"][i].clone();
            for (key, field) in command["patch"].as_object().unwrap() {
                if field.is_null() {
                    work.as_object_mut().unwrap().remove(key);
                } else {
                    work[key] = field.clone();
                }
            }
            if work.get("currentCandidateId") != value["workstreams"][i].get("currentCandidateId") {
                // Acceptance belongs to an exact candidate. Selecting another
                // candidate preserves evidence but requires fresh acceptance.
                for acceptance in rows_mut(&mut work, "acceptance") {
                    if acceptance["status"] == "satisfied" {
                        acceptance["status"] = json!("reopened");
                    }
                }
            }
            if work["status"] == "completed"
                && (rows(&work, "acceptance").is_empty()
                    || rows(&work, "acceptance")
                        .iter()
                        .any(|item| item["status"] != "satisfied"))
            {
                work["status"] = json!("ready");
            }
            validate_work(db, value, &work)?;
            if work != value["workstreams"][i] {
                touch(&mut work);
            }
            value["workstreams"][i] = work;
            Ok(())
        }
        "resource.put" => {
            let row = &command["resource"];
            check_project(db, &row["projectId"])?;
            if row.get("workstreamId").is_some() {
                work_index(db, value, row)?;
            }
            // Explicit replacement is allowed for a canonical reference, never across identities.
            if let Ok(i) = index(value, "resources", &row["id"]) {
                let old = &value["resources"][i];
                if old["projectId"] != row["projectId"]
                    || old.get("workstreamId") != row.get("workstreamId")
                {
                    return Err(Error::conflict("resource scope is immutable"));
                }
                value["resources"][i] = row.clone();
            } else {
                insert(value, "resources", row.clone())?;
            }
            for work in rows_mut(value, "workstreams") {
                if work["projectId"] == row["projectId"]
                    && row.get("workstreamId").is_none_or(|id| work["id"] == *id)
                {
                    touch(work);
                }
            }
            Ok(())
        }
        "decision.propose" => {
            let row = &command["decision"];
            work_index(db, value, row)?;
            if row["state"] != "proposed"
                || row.get("adoptedRevision").is_some()
                || row.get("adoptedBy").is_some()
            {
                return Err(Error::invalid("new decision must be an unadopted proposal"));
            }
            if let Some(id) = row.get("supersedesId") {
                check_scope(find(value, "decisions", id)?, row)?;
            }
            insert(value, "decisions", row.clone())
        }
        "decision.resolve" => {
            let wi = work_index(db, value, command)?;
            let di = index(value, "decisions", &command["decisionId"])?;
            check_scope(&value["decisions"][di], command)?;
            if value["decisions"][di]["state"] != "proposed"
                && value["decisions"][di]["state"] != "alternative"
            {
                return Err(Error::conflict(
                    "only a proposal or retained alternative can be resolved",
                ));
            }
            match command["resolution"].as_str().unwrap() {
                "adopt" => {
                    if let Some(id) = value["decisions"][di].get("supersedesId").cloned() {
                        let old = index(value, "decisions", &id)?;
                        if value["decisions"][old]["state"] != "effective" {
                            return Err(Error::conflict(
                                "superseded decision is no longer effective",
                            ));
                        }
                        value["decisions"][old]["state"] = json!("superseded");
                    }
                    let revision = value["workstreams"][wi]["decisionRevision"]
                        .as_u64()
                        .unwrap()
                        + 1;
                    value["workstreams"][wi]["decisionRevision"] = json!(revision);
                    touch(&mut value["workstreams"][wi]);
                    value["decisions"][di]["state"] = json!("effective");
                    value["decisions"][di]["adoptedRevision"] = json!(revision);
                    value["decisions"][di]["adoptedBy"] = command["source"].clone();
                }
                "dismiss" => value["decisions"][di]["state"] = json!("dismissed"),
                "alternative" => value["decisions"][di]["state"] = json!("alternative"),
                _ => unreachable!(),
            }
            Ok(())
        }
        "authorization.grant" => {
            let row = &command["authorization"];
            work_index(db, value, row)?;
            if row["source"]["kind"] != "user"
                || row["revoked"] != false
                || rows(row, "actions").is_empty()
                || rows(row, "resources").is_empty()
            {
                return Err(Error::unauthorized(
                    "authorization requires explicit user source, actions and resources",
                ));
            }
            if let Some(expiry) = row.get("expiresAt") {
                parse_expiry(expiry)?;
            }
            insert(value, "authorizations", row.clone())
        }
        "authorization.revoke" => {
            work_index(db, value, command)?;
            let i = index(value, "authorizations", &command["authorizationId"])?;
            check_scope(&value["authorizations"][i], command)?;
            value["authorizations"][i]["revoked"] = json!(true);
            Ok(())
        }
        "artifact.put" => {
            let row = &command["artifact"];
            work_index(db, value, row)?;
            if let Some(id) = row.get("runId") {
                check_scope(find(value, "runs", id)?, row)?;
            }
            if let Some(id) = row.get("supersedesId") {
                check_scope(find(value, "artifacts", id)?, row)?;
            }
            insert(value, "artifacts", row.clone())
        }
        "evidence.add" | "feedback.add" => {
            let feedback = command["kind"] == "feedback.add";
            let row = &command[if feedback { "feedback" } else { "evidence" }];
            let wi = work_index(db, value, row)?;
            let candidate = find(value, "artifacts", &row["candidateId"])?;
            check_scope(candidate, row)?;
            if candidate["kind"] != "candidate"
                || candidate["revision"] != row["candidateRevision"]
                || candidate["environment"] != row["environment"]
            {
                return Err(Error::invalid(
                    "feedback/evidence must target exact candidate revision and environment",
                ));
            }
            let ai = rows(&value["workstreams"][wi], "acceptance")
                .iter()
                .position(|a| a["id"] == row["acceptanceId"])
                .ok_or_else(|| Error::missing("acceptance item not found"))?;
            insert(
                value,
                if feedback { "feedback" } else { "evidence" },
                row.clone(),
            )?;
            if feedback {
                // Historical feedback remains attached to history; it must not reopen a new candidate.
                if value["workstreams"][wi]["currentCandidateId"] == row["candidateId"] {
                    value["workstreams"][wi]["acceptance"][ai]["status"] = json!("reopened");
                    if value["workstreams"][wi]["status"] == "completed" {
                        value["workstreams"][wi]["status"] = json!("ready");
                    }
                    touch(&mut value["workstreams"][wi]);
                }
            } else {
                let ids = rows_mut(
                    &mut value["workstreams"][wi]["acceptance"][ai],
                    "evidenceIds",
                );
                ids.push(row["id"].clone());
                touch(&mut value["workstreams"][wi]);
            }
            Ok(())
        }
        _ => Err(Error::invalid("unsupported workflow command")),
    }
}

pub(super) fn touch(work: &mut Value) {
    work["revision"] = json!(work["revision"].as_u64().unwrap() + 1);
    work["updatedAt"] = json!(crate::db::ms_to_ts(now_ms()));
}

fn parse_expiry(value: &Value) -> Result<i64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap())
        .map(|t| t.timestamp_millis())
        .map_err(|_| Error::invalid("expiresAt must be RFC3339"))
}

fn validate_work(db: &Database, value: &Value, work: &Value) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for acceptance in rows(work, "acceptance") {
        if !seen.insert(acceptance["id"].as_str().unwrap()) {
            return Err(Error::invalid("duplicate acceptance identity"));
        }
        for id in rows(acceptance, "evidenceIds") {
            let evidence = find(value, "evidence", id)?;
            if evidence["workstreamId"] != work["id"]
                || evidence["acceptanceId"] != acceptance["id"]
            {
                return Err(Error::invalid("acceptance evidence outside item"));
            }
        }
        if acceptance["status"] == "satisfied" {
            let candidate = work
                .get("currentCandidateId")
                .ok_or_else(|| Error::invalid("satisfied acceptance requires current candidate"))?;
            let artifact = find(value, "artifacts", candidate)?;
            if !rows(acceptance, "evidenceIds").iter().any(|id| {
                find(value, "evidence", id).is_ok_and(|e| {
                    e["candidateId"] == *candidate
                        && e["candidateRevision"] == artifact["revision"]
                        && e["outcome"] == "passed"
                })
            }) {
                return Err(Error::invalid(
                    "satisfied acceptance requires passed evidence for current candidate",
                ));
            }
        }
    }
    for id in rows(work, "dependencyIds") {
        if *id == work["id"] {
            return Err(Error::invalid("workstream cannot depend on itself"));
        }
        let dependency = find(value, "workstreams", id)?;
        if dependency["projectId"] != work["projectId"] {
            return Err(Error::invalid("dependency outside project"));
        }
        if reaches(
            value,
            id,
            &work["id"],
            &mut std::collections::HashSet::new(),
        )? {
            return Err(Error::invalid("dependency cycle"));
        }
    }
    if let Some(session) = work.get("mainSessionId") {
        check_session_scope(db, session, &work["projectId"])?;
    }
    if work["owner"]["kind"] == "session" {
        check_session(db, &work["owner"]["ref"])?;
    }
    if let Some(id) = work.get("currentCandidateId") {
        let candidate = find(value, "artifacts", id)?;
        if candidate["workstreamId"] != work["id"] || candidate["kind"] != "candidate" {
            return Err(Error::invalid(
                "currentCandidateId must identify this workstream's candidate",
            ));
        }
    }
    Ok(())
}

fn reaches(
    value: &Value,
    from: &Value,
    target: &Value,
    seen: &mut std::collections::HashSet<String>,
) -> Result<bool> {
    if from == target {
        return Ok(true);
    }
    if !seen.insert(from.as_str().unwrap().to_owned()) {
        return Ok(false);
    }
    for id in rows(find(value, "workstreams", from)?, "dependencyIds") {
        if reaches(value, id, target, seen)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn check_sources(db: &Database, value: &Value, node: &Value) -> Result<()> {
    if let Some(map) = node.as_object() {
        if let (Some(kind), Some(reference)) =
            (map.get("kind").and_then(Value::as_str), map.get("ref"))
        {
            match kind {
                "session" => check_session(db, reference)?,
                "message" => {
                    let exists: bool = db.conn().query_row(
                        "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1)",
                        params![reference.as_str()],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(Error::missing("source message not found"));
                    }
                }
                "run" => {
                    find(value, "runs", reference)?;
                }
                _ => (),
            }
        }
        for child in map.values() {
            check_sources(db, value, child)?;
        }
    } else if let Some(array) = node.as_array() {
        for child in array {
            check_sources(db, value, child)?;
        }
    }
    Ok(())
}
