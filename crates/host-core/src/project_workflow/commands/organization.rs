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
            navigation_tree::validate_parent(value, folder)?;
            if let Ok(i) = existing {
                if !navigation_tree::same_scope(&value["folders"][i], folder) {
                    return Err(Error::invalid("folder scope is immutable"));
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
                            }
                        }
                    }
                }
            }
            rows_mut(value, "expandedIds").retain(|expanded| expanded != id);
            Ok(())
        }
        "navigation.move" => {
            if let Some(id) = command.get("folderId") {
                find(value, "folders", id)?;
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
                    Some(id) => value["navigation"][i]["folderId"] = id.clone(),
                    None => {
                        value["navigation"][i]
                            .as_object_mut()
                            .unwrap()
                            .remove("folderId");
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
        _ => unreachable!(),
    }
}
