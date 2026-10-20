use super::*;

pub(super) fn search(db: &Database, request: &Value) -> Result<Value> {
    validation::validate(request, "search")?;
    let value = load(db)?;
    let resolved = check_query(db, &value, request)?;
    let request = &resolved;
    if let Some(session) = request.get("sessionId") {
        check_session(db, session)?;
    }
    let query = request["query"].as_str().unwrap().trim().to_lowercase();
    if query.is_empty() {
        return Ok(json!({"hits":[]}));
    }
    let limit = request.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
    let groups = db.list_project_groups()?;
    let mut hits = vec![];
    for (key, kind, fields) in [
        (
            "workstreams",
            "workstream",
            vec!["title", "goal", "nextAction"],
        ),
        ("decisions", "decision", vec!["title", "statement"]),
        ("artifacts", "artifact", vec!["label", "entryPoint"]),
    ] {
        for row in rows(&value, key) {
            if request.get("sessionId").is_some() || !scoped(row, request) {
                continue;
            }
            if fields.iter().any(|field| {
                row[*field]
                    .as_str()
                    .is_some_and(|text| text.to_lowercase().contains(&query))
            }) {
                let work_id = if kind == "workstream" {
                    &row["id"]
                } else {
                    &row["workstreamId"]
                };
                let work = find(&value, "workstreams", work_id)?;
                let project = groups
                    .iter()
                    .find(|group| Some(group.id.as_str()) == row["projectId"].as_str());
                let label = row
                    .get("title")
                    .or_else(|| row.get("label"))
                    .cloned()
                    .unwrap();
                let mut hit = json!({"kind":kind,"id":row["id"],"label":label,"excerpt":row[fields[fields.len()-1]],
                    "projectId":row["projectId"],"workstreamId":work_id,
                    "breadcrumb":[project.map(|p|p.name.as_str()).unwrap_or("Project"),work["title"].as_str().unwrap(),label.as_str().unwrap()]});
                if kind == "artifact" {
                    hit["artifactId"] = row["id"].clone();
                }
                hits.push(hit);
            }
        }
    }
    let mut offset = 0;
    while hits.len() < limit {
        let page = crate::session_search::search(db, &query, offset, 30)?;
        for matched in page.hits {
            let session = serde_json::to_value(&matched.session)?;
            let id = &session["id"];
            if request.get("sessionId").is_some_and(|sid| sid != id) {
                continue;
            }
            let link = rows(&value, "conversations")
                .iter()
                .find(|row| row["sessionId"] == *id);
            if link.is_some_and(|row| row["visibility"] == "side_only")
                && request.get("sessionId") != Some(id)
            {
                continue;
            }
            let inferred = if link.is_none() {
                // Reuse canonical path -> ProjectGroup resolution for unlinked legacy sessions.
                session
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(|p| db.project_group_for_path(p))
                    .transpose()?
                    .flatten()
            } else {
                None
            };
            let project_id = link
                .and_then(|row| row.get("projectId"))
                .cloned()
                .or_else(|| inferred.as_ref().map(|p| json!(p.id)));
            let work_id = link.and_then(|row| row.get("workstreamId"));
            if request
                .get("projectId")
                .is_some_and(|p| Some(p) != project_id.as_ref())
                || request
                    .get("workstreamId")
                    .is_some_and(|w| Some(w) != work_id)
            {
                continue;
            }
            let mut breadcrumb = vec![];
            if let Some(project) = project_id
                .as_ref()
                .and_then(|id| groups.iter().find(|p| Some(p.id.as_str()) == id.as_str()))
            {
                breadcrumb.push(json!(project.name));
            }
            if let Some(work) = work_id.and_then(|id| find(&value, "workstreams", id).ok()) {
                breadcrumb.push(work["title"].clone());
            }
            breadcrumb.push(session["title"].clone());
            if matched.matches.is_empty() {
                hits.push(message_hit(
                    id,
                    &session["title"],
                    None,
                    session["title"].as_str().unwrap_or(""),
                    project_id.as_ref(),
                    work_id,
                    &breadcrumb,
                ));
            } else {
                for message in matched.matches {
                    hits.push(message_hit(
                        id,
                        &session["title"],
                        Some(&message.message_id),
                        &message.snippet,
                        project_id.as_ref(),
                        work_id,
                        &breadcrumb,
                    ));
                }
            }
            if hits.len() >= limit {
                break;
            }
        }
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    hits.truncate(limit);
    Ok(json!({"hits":hits}))
}

fn message_hit(
    session: &Value,
    label: &Value,
    message: Option<&str>,
    excerpt: &str,
    project: Option<&Value>,
    work: Option<&Value>,
    breadcrumb: &[Value],
) -> Value {
    let mut hit = json!({"kind":"message","id":message.map(json_string).unwrap_or_else(||session.clone()),"label":label,"excerpt":excerpt,"sessionId":session,"breadcrumb":breadcrumb});
    if let Some(id) = project {
        hit["projectId"] = id.clone();
    }
    if let Some(id) = work {
        hit["workstreamId"] = id.clone();
    }
    if let Some(id) = message {
        hit["messageId"] = json!(id);
    }
    hit
}
fn json_string(s: &str) -> Value {
    json!(s)
}
