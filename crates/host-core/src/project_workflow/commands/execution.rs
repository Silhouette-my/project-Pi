use super::*;

pub(super) fn apply(db: &Database, value: &mut Value, command: &Value) -> Result<()> {
    match command["kind"].as_str().unwrap() {
        "workstream.transition" => {
            let wi = work_index(db, value, command)?;
            let mut work = value["workstreams"][wi].clone();
            let old = work["status"].as_str().unwrap();
            let next = command["status"].as_str().unwrap();
            if !work_transition(old, next) {
                return Err(Error::conflict(format!(
                    "invalid workstream transition {old} -> {next}"
                )));
            }
            if next == "blocked" && command.get("blocker").is_none() {
                return Err(Error::invalid(
                    "blocked work requires blocker owner and resume condition",
                ));
            }
            if next == "completed" && work["executionMode"] != "session" {
                if rows(&work, "acceptance").is_empty()
                    || !rows(&work, "acceptance")
                        .iter()
                        .all(|a| a["status"] == "satisfied")
                {
                    return Err(Error::conflict(
                        "workstream completion requires satisfied acceptance",
                    ));
                }
                validate_work(db, value, &work)?;
            }
            if next == "completed" && work["executionMode"] == "session" {
                let terminal = rows(value, "runs").iter().rev().find(|run| {
                    run["workstreamId"] == work["id"] && run["sessionId"] == work["mainSessionId"]
                });
                if terminal.is_none_or(|run| {
                    run["state"] != "completed"
                        || run["decisionRevision"] != work["decisionRevision"]
                        || run.get("completionKey").is_none()
                        || rows(run, "effects")
                            .iter()
                            .any(|effect| effect["state"] == "unknown")
                }) {
                    return Err(Error::conflict(
                        "session task completion requires its current Agent terminal receipt",
                    ));
                }
            }
            if next == "executing" {
                for dependency in rows(&work, "dependencyIds") {
                    if find(value, "workstreams", dependency)?["status"] != "completed" {
                        return Err(Error::conflict("workstream dependency is not completed"));
                    }
                }
            }
            work["status"] = command["status"].clone();
            work["nextAction"] = command["nextAction"].clone();
            if let Some(blocker) = command.get("blocker") {
                work["blocker"] = blocker.clone();
            } else {
                work.as_object_mut().unwrap().remove("blocker");
            }
            if work != value["workstreams"][wi] {
                touch(&mut work);
            }
            value["workstreams"][wi] = work;
            Ok(())
        }
        "run.start" => {
            let row = &command["run"];
            let wi = work_index(db, value, row)?;
            let work = &value["workstreams"][wi];
            check_session_scope(db, &row["sessionId"], &row["projectId"])?;
            if let Some(link) = rows(value, "conversations")
                .iter()
                .find(|link| link["sessionId"] == row["sessionId"])
            {
                check_scope(link, row)?;
            }
            if row["workstreamRevision"] != work["revision"]
                || row["decisionRevision"] != work["decisionRevision"]
            {
                return Err(Error::conflict(
                    "run must start at current workstream/decision revision",
                ));
            }
            if row.get("executionMode") != work.get("executionMode") {
                return Err(Error::invalid(
                    "run execution mode must match its workstream",
                ));
            }
            if !["ready", "executing"].contains(&work["status"].as_str().unwrap()) {
                return Err(Error::conflict("workstream is not runnable"));
            }
            if !["queued", "executing"].contains(&row["state"].as_str().unwrap())
                || row.get("completionKey").is_some()
            {
                return Err(Error::invalid("new run must be queued or executing"));
            }
            if rows(value, "runs").iter().any(|run| {
                run["workstreamId"] == row["workstreamId"]
                    && (run["state"] == "unknown"
                        || rows(run, "effects")
                            .iter()
                            .any(|effect| effect["state"] == "unknown")
                        || (run["sessionId"] == row["sessionId"]
                            && ["queued", "executing", "paused"]
                                .contains(&run["state"].as_str().unwrap())))
            }) {
                return Err(Error::conflict(
                    "session already has an active run or workstream has an unknown effect",
                ));
            }
            for dependency in rows(work, "dependencyIds") {
                if find(value, "workstreams", dependency)?["status"] != "completed" {
                    return Err(Error::conflict("workstream dependency is not completed"));
                }
            }
            if row["executionMode"] == "session" {
                if row.get("authorizationId").is_some() {
                    return Err(Error::invalid(
                        "session execution uses session permissions, not workflow authorization",
                    ));
                }
                return insert(value, "runs", row.clone());
            }
            let authorization_id = row.get("authorizationId").ok_or_else(|| {
                Error::unauthorized("bounded execution requires workflow authorization")
            })?;
            let authorization = find(value, "authorizations", authorization_id)?;
            check_scope(authorization, row)?;
            if authorization["revoked"] == true
                || authorization
                    .get("expiresAt")
                    .map(parse_expiry)
                    .transpose()?
                    .is_some_and(|t| t <= now_ms())
            {
                return Err(Error::unauthorized("authorization revoked or expired"));
            }
            let used = rows(value, "runs")
                .iter()
                .filter(|run| run["authorizationId"] == row["authorizationId"])
                .count() as u64;
            if used >= authorization["maxRuns"].as_u64().unwrap() {
                return Err(Error::unauthorized("authorization run budget exhausted"));
            }
            for effect in rows(row, "effects") {
                if !rows(authorization, "actions").contains(&effect["action"])
                    || !rows(authorization, "resources").contains(&effect["resource"])
                {
                    return Err(Error::unauthorized(
                        "planned effect outside authorization scope",
                    ));
                }
            }
            insert(value, "runs", row.clone())?;
            super::super::tool_scope::capture_dispatch(db, row)
        }
        "run.observe" => {
            work_index(db, value, command)?;
            let i = index(value, "runs", &command["runId"])?;
            let run = &value["runs"][i];
            check_scope(run, command)?;
            let old = run["state"].as_str().unwrap();
            let next = command["state"].as_str().unwrap();
            if !run_transition(old, next) {
                return Err(Error::conflict(format!(
                    "invalid run transition {old} -> {next}"
                )));
            }
            if let Some(key) = command.get("completionKey") {
                if rows(value, "runs")
                    .iter()
                    .enumerate()
                    .any(|(j, r)| j != i && r.get("completionKey") == Some(key))
                {
                    return Err(Error::conflict(
                        "completionKey already belongs to another run",
                    ));
                }
                if run.get("completionKey").is_some_and(|k| k != key) {
                    return Err(Error::conflict("run completion identity is immutable"));
                }
            }
            for prior in rows(run, "effects") {
                let current = rows(command, "effects")
                    .iter()
                    .find(|effect| effect["id"] == prior["id"])
                    .ok_or_else(|| Error::invalid("observed effects cannot be erased"))?;
                if current["action"] != prior["action"]
                    || current["resource"] != prior["resource"]
                    || (prior["state"] == "confirmed" && current["state"] != "confirmed")
                {
                    return Err(Error::invalid(
                        "effect identity/confirmed effects are immutable",
                    ));
                }
            }
            for key in ["state", "outcome", "effects", "completionKey"] {
                if let Some(field) = command.get(key) {
                    value["runs"][i][key] = field.clone();
                }
            }
            value["runs"][i]["updatedAt"] = json!(crate::db::ms_to_ts(now_ms()));
            // Observed run completion deliberately does not accept or complete work.
            Ok(())
        }
        "delivery.publish" => {
            let row = &command["delivery"];
            let wi = work_index(db, value, row)?;
            let run = find(value, "runs", &row["sourceRunId"])?;
            check_scope(run, row)?;
            if row["decisionRevision"] != run["decisionRevision"] {
                return Err(Error::invalid(
                    "delivery must retain source run decision revision",
                ));
            }
            if row["state"] == "consumed"
                || row["disposition"] != "pending"
                || row.get("consumedAt").is_some()
            {
                return Err(Error::invalid("new delivery is unconsumed and pending"));
            }
            for id in rows(row, "artifactIds") {
                check_scope(find(value, "artifacts", id)?, row)?;
            }
            let mut delivery = row.clone();
            if delivery["decisionRevision"] != value["workstreams"][wi]["decisionRevision"] {
                delivery["disposition"] = json!("stale");
            }
            if let Ok(i) = index(value, "deliveries", &delivery["id"]) {
                let old = &value["deliveries"][i];
                let mut produced = old.clone();
                produced["state"] = delivery["state"].clone();
                // Disposition is derived by the host from current decisions,
                // so adoption between production and delivery may change it.
                produced["disposition"] = delivery["disposition"].clone();
                if old["state"] != "produced"
                    || delivery["state"] != "delivered"
                    || produced != delivery
                {
                    return Err(Error::conflict(
                        "delivery payload is immutable; only produced -> delivered is allowed",
                    ));
                }
                value["deliveries"][i] = delivery;
                Ok(())
            } else {
                insert(value, "deliveries", delivery)
            }
        }
        "delivery.consume" => {
            let wi = work_index(db, value, command)?;
            let i = index(value, "deliveries", &command["deliveryId"])?;
            check_scope(&value["deliveries"][i], command)?;
            if value["deliveries"][i]["state"] != "delivered" {
                return Err(Error::conflict(
                    "only delivered results can be consumed once",
                ));
            }
            if command["disposition"] == "pending" {
                return Err(Error::invalid("consumption requires a final disposition"));
            }
            let stale = value["deliveries"][i]["decisionRevision"]
                != value["workstreams"][wi]["decisionRevision"];
            value["deliveries"][i]["state"] = json!("consumed");
            value["deliveries"][i]["disposition"] = if stale {
                json!("stale")
            } else {
                command["disposition"].clone()
            };
            value["deliveries"][i]["consumedAt"] = json!(crate::db::ms_to_ts(now_ms()));
            Ok(())
        }
        _ => unreachable!(),
    }
}

fn work_transition(old: &str, next: &str) -> bool {
    old == next
        || match old {
            "draft" => matches!(
                next,
                "ready" | "paused" | "blocked" | "awaiting_user" | "cancelled"
            ),
            "ready" | "executing" | "paused" | "blocked" | "awaiting_user" => next != "draft",
            "completed" | "cancelled" => matches!(next, "ready"),
            _ => false,
        }
}
fn run_transition(old: &str, next: &str) -> bool {
    if old == next {
        return true;
    }
    match old {
        "queued" => matches!(
            next,
            "executing" | "paused" | "cancelled" | "interrupted" | "unknown" | "failed"
        ),
        "executing" => matches!(
            next,
            "paused" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown"
        ),
        "paused" => matches!(next, "executing" | "cancelled" | "interrupted" | "unknown"),
        "interrupted" | "unknown" => matches!(next, "completed" | "failed" | "cancelled"),
        _ => false,
    }
}
