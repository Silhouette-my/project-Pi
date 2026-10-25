use super::*;

pub(super) fn apply(db: &Database, value: &mut Value, command: &Value) -> Result<()> {
    match command["kind"].as_str().unwrap() {
        "folder.create" | "folder.update" => {
            let folder = &command["folder"];
            let existing = index(value, "folders", &folder["id"]);
            if command["kind"] == "folder.create" && existing.is_ok() {
                return Err(Error::conflict("folder already exists"));
            }
            if command["kind"] == "folder.update" && existing.is_err() {
                return Err(Error::missing("folder not found"));
            }
            navigation_tree::validate_scope(db, folder)?;
            if let Some(category) = folder.get("categoryId") {
                navigation_tree::check_category(value, category)?;
            }
            navigation_tree::validate_parent(value, folder)?;
            if let Ok(i) = existing {
                if !navigation_tree::same_scope(&value["folders"][i], folder) {
                    return Err(Error::invalid("folder scope is immutable"));
                }
                // Category changes go through tree.move so descendants follow.
                if navigation_tree::scope(folder) != "project"
                    && navigation_tree::folder_category(&value["folders"][i])
                        != navigation_tree::folder_category(folder)
                {
                    return Err(Error::invalid("folder category changes through tree.move"));
                }
            }
            match existing {
                Ok(i) => value["folders"][i] = folder.clone(),
                Err(_) => rows_mut(value, "folders").push(folder.clone()),
            }
            Ok(())
        }
        "folder.remove" => {
            let id = &command["folderId"];
            let i = index(value, "folders", id)?;
            let parent = value["folders"][i].get("parentId").cloned();
            let removed = value["folders"][i].clone();
            rows_mut(value, "folders").remove(i);
            // Promote direct children without deleting their navigation or execution identity.
            for row in rows_mut(value, "folders") {
                if row.get("parentId") == Some(id) {
                    match &parent {
                        Some(parent) => row["parentId"] = parent.clone(),
                        None => {
                            row.as_object_mut().unwrap().remove("parentId");
                        }
                    }
                }
            }
            for key in ["navigation", "projectNavigation"] {
                if value.get(key).is_none() {
                    continue;
                }
                for row in rows_mut(value, key) {
                    if row.get("folderId") == Some(id) {
                        match &parent {
                            Some(parent) => row["folderId"] = parent.clone(),
                            None => {
                                row.as_object_mut().unwrap().remove("folderId");
                                // A root entry keeps the category its folder was in.
                                if navigation_tree::scope(&removed) != "project" {
                                    row["categoryId"] =
                                        json!(navigation_tree::folder_category(&removed));
                                }
                            }
                        }
                    }
                }
            }
            rows_mut(value, "expandedIds").retain(|expanded| expanded != id);
            Ok(())
        }
        "category.create" | "category.update" => {
            let category = &command["category"];
            let id = category["id"].as_str().unwrap();
            if id == navigation_tree::CHATS || id == navigation_tree::PROJECTS {
                return Err(Error::invalid("built-in categories cannot be edited"));
            }
            let existing = rows(value, "categories")
                .iter()
                .position(|row| row["id"] == category["id"]);
            match (command["kind"].as_str().unwrap(), existing) {
                ("category.create", Some(_)) => Err(Error::conflict("category already exists")),
                ("category.update", None) => Err(Error::missing("category not found")),
                (_, Some(i)) => {
                    value["categories"][i] = category.clone();
                    Ok(())
                }
                (_, None) => {
                    rows_mut(value, "categories").push(category.clone());
                    Ok(())
                }
            }
        }
        // Contents fall back to the matching built-in category: folders and
        // conversations to Chats, projects to Projects. Nothing is deleted.
        "category.remove" => {
            let id = &command["categoryId"];
            let i = index(value, "categories", id)?;
            rows_mut(value, "categories").remove(i);
            for row in rows_mut(value, "folders") {
                if navigation_tree::scope(row) != "project"
                    && navigation_tree::folder_category(row) == id.as_str().unwrap()
                {
                    row["categoryId"] = json!(navigation_tree::CHATS);
                }
            }
            for row in rows_mut(value, "navigation") {
                if row.get("categoryId") == Some(id) {
                    row["categoryId"] = json!(navigation_tree::CHATS);
                }
            }
            for row in rows_mut(value, "projectNavigation") {
                if row.get("categoryId") == Some(id) {
                    row["categoryId"] = json!(navigation_tree::PROJECTS);
                }
            }
            rows_mut(value, "expandedIds").retain(|expanded| expanded != id);
            Ok(())
        }
        "navigation.move" => {
            if let Some(id) = command.get("folderId") {
                find(value, "folders", id)?;
            }
            if let Some(id) = command.get("categoryId") {
                navigation_tree::check_category(value, id)?;
            }
            for session in rows(command, "sessionIds") {
                check_session(db, session)?;
                navigation_tree::validate_destination(db, value, session, command.get("folderId"))?;
            }
            for session in rows(command, "sessionIds") {
                let i = rows(value, "navigation")
                    .iter()
                    .position(|row| row["sessionId"] == *session);
                let i = i.unwrap_or_else(|| {
                    let order = rows(value, "navigation").len();
                    rows_mut(value, "navigation")
                        .push(json!({"sessionId":session,"order":order,"favorite":false}));
                    order
                });
                match command.get("folderId") {
                    Some(id) => {
                        value["navigation"][i]["folderId"] = id.clone();
                        value["navigation"][i]
                            .as_object_mut()
                            .unwrap()
                            .remove("categoryId");
                    }
                    None => {
                        let row = value["navigation"][i].as_object_mut().unwrap();
                        row.remove("folderId");
                        match command.get("categoryId") {
                            Some(category) => {
                                row.insert("categoryId".into(), category.clone());
                            }
                            None => {
                                row.remove("categoryId");
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        "navigation.update" => {
            let row = &command["navigation"];
            check_session(db, &row["sessionId"])?;
            if let Some(id) = row.get("folderId") {
                find(value, "folders", id)?;
            }
            if let Some(id) = row.get("categoryId") {
                navigation_tree::check_category(value, id)?;
            }
            navigation_tree::validate_destination(
                db,
                value,
                &row["sessionId"],
                row.get("folderId"),
            )?;
            if let Some(id) = row.get("lastMessageId") {
                check_message(db, id, &row["sessionId"])?;
            }
            if let Some(i) = rows(value, "navigation")
                .iter()
                .position(|old| old["sessionId"] == row["sessionId"])
            {
                value["navigation"][i] = row.clone();
            } else {
                rows_mut(value, "navigation").push(row.clone());
            }
            Ok(())
        }
        // The project's favourite flag lives on its navigation row; absent means
        // not a favourite, so rows written before this command load unchanged.
        "project.favorite" => {
            let id = &command["projectId"];
            check_project(db, id)?;
            if value.get("projectNavigation").is_none() {
                value["projectNavigation"] = json!([]);
            }
            let i = rows(value, "projectNavigation")
                .iter()
                .position(|row| row["projectId"] == *id)
                .unwrap_or_else(|| {
                    let order = command.get("order").cloned().unwrap_or(json!(0));
                    rows_mut(value, "projectNavigation")
                        .push(json!({"projectId":id,"order":order}));
                    rows(value, "projectNavigation").len() - 1
                });
            value["projectNavigation"][i]["favorite"] = command["favorite"].clone();
            Ok(())
        }
        "navigation.expand" => {
            value["expandedIds"] = command["expandedIds"].clone();
            Ok(())
        }
        "conversation.link" => {
            let row = &command["conversation"];
            let wi = work_index(db, value, row)?;
            check_session_scope(db, &row["sessionId"], &row["projectId"])?;
            if let Some(parent) = row.get("parentSessionId") {
                check_session(db, parent)?;
                if *parent == row["sessionId"] {
                    return Err(Error::invalid("conversation cannot parent itself"));
                }
                let mut ancestor = Some(parent.clone());
                let mut seen = std::collections::HashSet::new();
                while let Some(id) = ancestor {
                    if id == row["sessionId"] || !seen.insert(id.clone().to_string()) {
                        return Err(Error::invalid("conversation parent cycle"));
                    }
                    ancestor = rows(value, "conversations")
                        .iter()
                        .find(|c| c["sessionId"] == id)
                        .and_then(|c| c.get("parentSessionId"))
                        .cloned();
                }
                if let Some(source) = row.get("sourceMessageId") {
                    check_message(db, source, parent)?;
                }
            } else if let Some(source) = row.get("sourceMessageId") {
                check_message(db, source, &row["sessionId"])?;
            }
            if row["sourceRevision"].as_u64().unwrap()
                > value["workstreams"][wi]["revision"].as_u64().unwrap()
            {
                return Err(Error::invalid(
                    "conversation source revision is in the future",
                ));
            }
            for id in rows(&row["readContext"], "resourceIds") {
                let resource = find(value, "resources", id)?;
                if resource["projectId"] != row["projectId"]
                    || resource
                        .get("workstreamId")
                        .is_some_and(|id| *id != row["workstreamId"])
                {
                    return Err(Error::invalid("read context resource outside workstream"));
                }
            }
            if row["relation"] == "main" {
                if rows(value, "conversations").iter().any(|c| {
                    c["workstreamId"] == row["workstreamId"]
                        && c["relation"] == "main"
                        && c["sessionId"] != row["sessionId"]
                }) {
                    return Err(Error::conflict(
                        "workstream already has a main conversation",
                    ));
                }
                if value["workstreams"][wi].get("mainSessionId") != Some(&row["sessionId"]) {
                    value["workstreams"][wi]["mainSessionId"] = row["sessionId"].clone();
                    touch(&mut value["workstreams"][wi]);
                }
            }
            if let Some(i) = rows(value, "conversations")
                .iter()
                .position(|old| old["sessionId"] == row["sessionId"])
            {
                check_scope(&value["conversations"][i], row)?;
                // Binding/context/source are execution identity, not editable folder metadata.
                let old = &value["conversations"][i];
                for key in [
                    "parentSessionId",
                    "sourceMessageId",
                    "sourceRevision",
                    "relation",
                    "purpose",
                    "readContext",
                    "returnPolicy",
                ] {
                    if old.get(key) != row.get(key) {
                        return Err(Error::conflict(
                            "conversation context and ancestry are immutable",
                        ));
                    }
                }
                value["conversations"][i] = row.clone();
            } else {
                rows_mut(value, "conversations").push(row.clone());
            }
            Ok(())
        }
        "conversation.policy" => {
            let i = conversation_index(value, command)?;
            if value["conversations"][i]["relation"] == "main" {
                return Err(Error::conflict(
                    "the main conversation keeps its delivery policy",
                ));
            }
            // Only the return policy moves; context and ancestry stay immutable.
            value["conversations"][i]["returnPolicy"] = command["returnPolicy"].clone();
            Ok(())
        }
        "conversation.return" => {
            let i = conversation_index(value, command)?;
            let conversation = value["conversations"][i].clone();
            if conversation["relation"] == "main" {
                return Err(Error::conflict(
                    "the main conversation delivers through its runs",
                ));
            }
            let title = command["title"].as_str().unwrap().trim();
            let text = command["text"].as_str().unwrap().trim();
            if title.is_empty() || text.is_empty() {
                return Err(Error::invalid(
                    "a returned conversation needs a title and text",
                ));
            }
            let source = json!({"kind":"session","ref":conversation["sessionId"],
                "revision":conversation["sourceRevision"].to_string()});
            let (key, row) = match conversation["returnPolicy"].as_str().unwrap() {
                "proposal" => (
                    "decisions",
                    json!({"id":command["recordId"],"projectId":command["projectId"],
                        "workstreamId":command["workstreamId"],"title":title,"statement":text,
                        "state":"proposed","sources":[source],"createdAt":command["createdAt"]}),
                ),
                "delivery" => (
                    "artifacts",
                    json!({"id":command["recordId"],"projectId":command["projectId"],
                        "workstreamId":command["workstreamId"],"label":title,"kind":"report",
                        "revision":"1","environment":"",
                        "entryPoint":format!("session:{}", conversation["sessionId"].as_str().unwrap()),
                        "source":{"kind":"session","ref":conversation["sessionId"]},
                        "createdAt":command["createdAt"]}),
                ),
                _ => return Err(Error::conflict("this conversation does not return")),
            };
            insert(value, key, row)?;
            if key == "artifacts" {
                let wi = work_index(db, value, command)?;
                touch(&mut value["workstreams"][wi]);
            }
            Ok(())
        }
        _ => unreachable!(),
    }
}

fn conversation_index(value: &Value, command: &Value) -> Result<usize> {
    let i = rows(value, "conversations")
        .iter()
        .position(|row| row["sessionId"] == command["sessionId"])
        .ok_or_else(|| Error::missing("conversation not found"))?;
    check_scope(&value["conversations"][i], command)?;
    Ok(i)
}
