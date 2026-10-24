//! Navigation-only placement; execution identity is never changed here.
use super::*;

pub(super) const CHATS: &str = "chats";
pub(super) const PROJECTS: &str = "projects";

pub(super) fn scope(row: &Value) -> &str {
    row.get("scope").and_then(Value::as_str).unwrap_or(CHATS)
}
/// `chats` and `projects` are one category space: a category may mix folders,
/// standalone conversations and projects. Only `project` scope is separate.
fn space(row: &Value) -> &str {
    if scope(row) == "project" {
        "project"
    } else {
        "category"
    }
}
pub(super) fn same_scope(a: &Value, b: &Value) -> bool {
    space(a) == space(b) && a.get("projectId") == b.get("projectId")
}
/// Category a folder belongs to. Legacy rows without `categoryId` derive it
/// from their scope, so existing trees load unchanged.
pub(super) fn folder_category(folder: &Value) -> String {
    match folder.get("categoryId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None if scope(folder) == "projects" => PROJECTS.to_string(),
        None => CHATS.to_string(),
    }
}
pub(super) fn check_category(value: &Value, id: &Value) -> Result<()> {
    let known = id.as_str().is_some_and(|id| id == CHATS || id == PROJECTS)
        || rows(value, "categories").iter().any(|row| row["id"] == *id);
    if known {
        Ok(())
    } else {
        Err(Error::missing("category not found"))
    }
}
pub(super) fn validate_scope(db: &Database, row: &Value) -> Result<()> {
    if scope(row) == "project" && row.get("categoryId").is_some() {
        return Err(Error::invalid("categoryId requires category scope"));
    }
    if scope(row) == "project" {
        let id = row
            .get("projectId")
            .ok_or_else(|| Error::invalid("project scope requires projectId"))?;
        check_project(db, id)?;
    } else if row.get("projectId").is_some() {
        return Err(Error::invalid("projectId requires project scope"));
    }
    Ok(())
}
pub(super) fn validate_parent(value: &Value, folder: &Value) -> Result<()> {
    let mut parent = folder.get("parentId");
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = parent {
        if *id == folder["id"] || !seen.insert(id.to_string()) {
            return Err(Error::invalid("folder parent cycle"));
        }
        let ancestor = find(value, "folders", id)?;
        if !same_scope(ancestor, folder) {
            return Err(Error::invalid("folder parent is outside navigation scope"));
        }
        if space(folder) == "category" && folder_category(ancestor) != folder_category(folder) {
            return Err(Error::invalid("folder parent is in another category"));
        }
        parent = ancestor.get("parentId");
    }
    Ok(())
}
pub(super) fn validate_session(
    db: &Database,
    value: &Value,
    session: &Value,
    context: &Value,
) -> Result<()> {
    check_session(db, session)?;
    let path: Option<String> = db.conn().query_row(
        "SELECT p.path FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
        params![session.as_str()],
        |r| r.get(0),
    )?;
    if scope(context) == "project" {
        let explicitly_linked = rows(value, "conversations")
            .iter()
            .any(|row| row["sessionId"] == *session && row["projectId"] == context["projectId"])
            || rows(value, "workstreams").iter().any(|row| {
                row.get("mainSessionId") == Some(session)
                    && row["projectId"] == context["projectId"]
            });
        if path.is_none() && !explicitly_linked {
            return Err(Error::invalid("standalone session is outside project"));
        }
        check_session_scope(db, session, &context["projectId"])?;
    } else if path.is_some()
        || rows(value, "conversations")
            .iter()
            .any(|c| c["sessionId"] == *session)
    {
        return Err(Error::invalid(
            "project session is outside standalone chats",
        ));
    }
    if rows(value, "projectAgents")
        .iter()
        .any(|a| a["sessionId"] == *session)
    {
        return Err(Error::invalid("Project Agent is not a navigation entry"));
    }
    Ok(())
}
pub(super) fn validate_destination(
    db: &Database,
    value: &Value,
    session: &Value,
    folder: Option<&Value>,
) -> Result<()> {
    if let Some(id) = folder {
        let destination = find(value, "folders", id)?;
        // Legacy navigation commands accepted project sessions in unscoped
        // folders. Preserve that contract; tree.move always validates scope.
        if destination.get("scope").is_some() {
            validate_session(db, value, session, destination)?;
        }
    }
    Ok(())
}
fn place(row: &mut Value, folder: Option<&Value>, order: &Value, key: &str) {
    row["order"] = order.clone();
    match folder {
        Some(id) => row[key] = id.clone(),
        None => {
            row.as_object_mut().unwrap().remove(key);
        }
    }
}
/// Category a root-level placement lands in when no folder is given.
fn destination_category(value: &Value, command: &Value) -> Result<String> {
    if let Some(id) = command.get("folderId") {
        return Ok(folder_category(find(value, "folders", id)?));
    }
    Ok(match command.get("categoryId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None if scope(command) == "projects" => PROJECTS.to_string(),
        None => CHATS.to_string(),
    })
}
fn set_category(row: &mut Value, folder: Option<&Value>, category: &str) {
    match folder {
        Some(_) => {
            row.as_object_mut().unwrap().remove("categoryId");
        }
        None => row["categoryId"] = json!(category),
    }
}
fn cascade_category(value: &mut Value, root: &Value, category: &str) {
    let mut ids = vec![root.clone()];
    let mut next = 0;
    while next < ids.len() {
        let parent = ids[next].clone();
        next += 1;
        for row in rows_mut(value, "folders") {
            if row.get("parentId") == Some(&parent) {
                row["categoryId"] = json!(category);
                ids.push(row["id"].clone());
            }
        }
    }
}
pub(super) fn move_entry(db: &Database, value: &mut Value, command: &Value) -> Result<()> {
    validate_scope(db, command)?;
    if let Some(id) = command.get("categoryId") {
        check_category(value, id)?;
    }
    if let Some(id) = command.get("folderId") {
        let folder = find(value, "folders", id)?;
        if !same_scope(folder, command) {
            return Err(Error::invalid("destination is outside navigation scope"));
        }
        if command
            .get("categoryId")
            .and_then(Value::as_str)
            .is_some_and(|category| category != folder_category(folder))
        {
            return Err(Error::invalid("destination is in another category"));
        }
    }
    let category = destination_category(value, command)?;
    let id = &command["target"]["id"];
    match command["target"]["kind"].as_str().unwrap() {
        "folder" => {
            let i = index(value, "folders", id)?;
            let mut folder = value["folders"][i].clone();
            if !same_scope(&folder, command) {
                return Err(Error::invalid("folder scope is immutable"));
            }
            place(
                &mut folder,
                command.get("folderId"),
                &command["order"],
                "parentId",
            );
            if space(&folder) == "category" {
                folder["categoryId"] = json!(category);
            }
            validate_parent(value, &folder)?;
            let root = folder["id"].clone();
            value["folders"][i] = folder;
            if space(command) == "category" {
                cascade_category(value, &root, &category);
            }
        }
        "session" => {
            validate_session(db, value, id, command)?;
            let i = rows(value, "navigation")
                .iter()
                .position(|r| r["sessionId"] == *id)
                .unwrap_or_else(|| {
                    let i = rows(value, "navigation").len();
                    rows_mut(value, "navigation")
                        .push(json!({"sessionId":id,"order":0,"favorite":false}));
                    i
                });
            place(
                &mut value["navigation"][i],
                command.get("folderId"),
                &command["order"],
                "folderId",
            );
            if space(command) == "category" {
                set_category(
                    &mut value["navigation"][i],
                    command.get("folderId"),
                    &category,
                );
            }
        }
        "project" => {
            if space(command) != "category" {
                return Err(Error::invalid("projects require category scope"));
            }
            check_project(db, id)?;
            if value.get("projectNavigation").is_none() {
                value["projectNavigation"] = json!([]);
            }
            let i = rows(value, "projectNavigation")
                .iter()
                .position(|r| r["projectId"] == *id)
                .unwrap_or_else(|| {
                    let i = rows(value, "projectNavigation").len();
                    rows_mut(value, "projectNavigation").push(json!({"projectId":id,"order":0}));
                    i
                });
            place(
                &mut value["projectNavigation"][i],
                command.get("folderId"),
                &command["order"],
                "folderId",
            );
            set_category(
                &mut value["projectNavigation"][i],
                command.get("folderId"),
                &category,
            );
        }
        _ => unreachable!(),
    }
    if let Some(siblings) = command.get("siblingOrder").and_then(Value::as_array) {
        if siblings.len() > 1000 {
            return Err(Error::invalid("too many ordered siblings"));
        }
        let mut seen = std::collections::HashSet::new();
        for (order, target) in siblings.iter().enumerate() {
            if !seen.insert(target.to_string()) {
                return Err(Error::invalid("duplicate ordered sibling"));
            }
            let mut placement = command.clone();
            placement.as_object_mut().unwrap().remove("siblingOrder");
            placement["target"] = target.clone();
            placement["order"] = json!(order);
            move_entry(db, value, &placement)?;
        }
    }
    Ok(())
}
