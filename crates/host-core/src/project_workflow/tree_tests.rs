use super::*;

#[test]
fn tree_depth_scope_cycle_and_non_destructive_remove() {
    let f = Fixture::new();
    for (id, parent) in [
        ("a", None),
        ("b", Some("a")),
        ("c", Some("b")),
        ("d", Some("c")),
    ] {
        let mut folder =
            json!({"id":id,"name":id,"order":0,"scope":"project","projectId":f.project});
        if let Some(parent) = parent {
            folder["parentId"] = json!(parent);
        }
        f.execute("folder.create", json!({"folder":folder}));
    }
    let initial = snapshot(&f.db, &json!({})).unwrap();
    let cycle = f.command("tree.move", json!({"target":{"kind":"folder","id":"a"},"scope":"project","projectId":f.project,"folderId":"d","order":0}));
    assert_eq!(mutate(&f.db, &cycle).unwrap_err().code, "INVALID_ARGUMENT");
    assert_eq!(snapshot(&f.db, &json!({})).unwrap(), initial);
    f.execute("tree.move", json!({"target":{"kind":"session","id":f.session},"scope":"project","projectId":f.project,"folderId":"c","order":2}));
    let state = f.execute("folder.remove", json!({"folderId":"c"}));
    assert_eq!(state["navigation"][0]["folderId"], "b");
    assert_eq!(state["folders"][2]["parentId"], "b");
    check_session_scope(&f.db, &json!(f.session), &json!(f.project)).unwrap();
    let db = Database::open(&f._dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(snapshot(&db, &json!({})).unwrap(), state);
}

#[test]
fn tree_projects_mixed_order_and_replay_are_atomic() {
    let f = Fixture::new();
    f.execute(
        "folder.create",
        json!({"folder":{"id":"category","name":"Projects","scope":"projects","order":0}}),
    );
    f.execute("folder.create", json!({"folder":{"id":"nested","name":"Nested","scope":"projects","parentId":"category","order":0}}));
    let command = f.command("tree.move", json!({"target":{"kind":"project","id":f.project},"scope":"projects","folderId":"category","order":0,"siblingOrder":[{"kind":"project","id":f.project},{"kind":"folder","id":"nested"}]}));
    let state = mutate(&f.db, &command).unwrap()["snapshot"].clone();
    assert_eq!(state["projectNavigation"][0]["projectId"], f.project);
    assert_eq!(state["projectNavigation"][0]["order"], 0);
    assert_eq!(state["folders"][1]["order"], 1);
    assert!(mutate(&f.db, &command).unwrap()["replayed"]
        .as_bool()
        .unwrap());
    let removed = f.execute("folder.remove", json!({"folderId":"category"}));
    assert!(removed["projectNavigation"][0].get("folderId").is_none());
    assert!(removed["folders"][0].get("parentId").is_none());
    let before = snapshot(&f.db, &json!({})).unwrap();
    let invalid = f.command("tree.move", json!({"target":{"kind":"project","id":f.project},"scope":"projects","order":0,"siblingOrder":[{"kind":"session","id":f.session}]}));
    assert_eq!(
        mutate(&f.db, &invalid).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(snapshot(&f.db, &json!({})).unwrap(), before);
}

#[test]
fn tree_rejects_cross_scope_and_cross_project_without_changing_workspace() {
    let f = Fixture::new();
    let other_path = f._dir.path().join("other");
    std::fs::create_dir(&other_path).unwrap();
    let other =
        f.db.create_project_group("Other", &[other_path.to_string_lossy().to_string()])
            .unwrap();
    f.execute(
        "folder.create",
        json!({"folder":{"id":"global","name":"Chats","scope":"chats","order":0}}),
    );
    f.execute("folder.create", json!({"folder":{"id":"own","name":"Own","scope":"project","projectId":f.project,"order":0}}));
    let before = snapshot(&f.db, &json!({})).unwrap();
    for fields in [
        json!({"target":{"kind":"session","id":f.session},"scope":"chats","folderId":"global","order":0}),
        json!({"target":{"kind":"session","id":f.session},"scope":"project","projectId":other.id,"order":0}),
        json!({"target":{"kind":"folder","id":"own"},"scope":"project","projectId":f.project,"folderId":"global","order":0}),
        json!({"target":{"kind":"folder","id":"own"},"scope":"chats","order":0}),
    ] {
        assert_eq!(
            mutate(&f.db, &f.command("tree.move", fields))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(snapshot(&f.db, &json!({})).unwrap(), before);
    }
    check_session_scope(&f.db, &json!(f.session), &json!(f.project)).unwrap();
    // Existing navigation commands retain their unscoped legacy contract.
    f.execute(
        "folder.create",
        json!({"folder":{"id":"legacy","name":"Legacy","order":0}}),
    );
    f.execute(
        "navigation.move",
        json!({"sessionIds":[f.session],"folderId":"legacy"}),
    );
    f.execute("tree.move", json!({"target":{"kind":"session","id":f.session},"scope":"project","projectId":f.project,"order":0}));
    assert!(snapshot(&f.db, &json!({})).unwrap()["navigation"][0]
        .get("folderId")
        .is_none());
}

#[test]
fn tree_preserves_explicit_project_membership_without_a_workspace() {
    let f = Fixture::new();
    f.create_work();
    let linked = crate::sessions::create_session(
        &f.db,
        Some("Historical side".into()),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    f.execute("conversation.link", json!({"conversation":{
        "sessionId":linked.id,"projectId":f.project,"workstreamId":"w","relation":"child","parentSessionId":f.session,
        "sourceRevision":0,"purpose":"ask","visibility":"project","readContext":{"resourceIds":[],"includeDecisions":false,"includeArtifacts":false},
        "returnPolicy":"none","archived":false,"order":0
    }}));
    f.execute("folder.create", json!({"folder":{"id":"project-folder","name":"History","scope":"project","projectId":f.project,"order":0}}));
    f.execute("tree.move", json!({"target":{"kind":"session","id":linked.id},"scope":"project","projectId":f.project,"folderId":"project-folder","order":0}));
    let path: Option<String> =
        f.db.conn()
            .query_row(
                "SELECT project_id FROM sessions WHERE id=?1",
                params![linked.id],
                |r| r.get(0),
            )
            .unwrap();
    assert!(path.is_none(), "navigation must not assign a workspace");
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["navigation"][0]["folderId"], "project-folder");
}

fn standalone(f: &Fixture, title: &str) -> String {
    crate::sessions::create_session(&f.db, Some(title.into()), None, None, None, None)
        .unwrap()
        .id
}

#[test]
fn categories_mix_projects_and_conversations_and_fall_back_when_removed() {
    let f = Fixture::new();
    let chat = standalone(&f, "Reading list");
    f.execute(
        "category.create",
        json!({"category":{"id":"k","name":"Reading","order":0}}),
    );
    let duplicate = f.command(
        "category.create",
        json!({"category":{"id":"k","name":"Again","order":1}}),
    );
    assert_eq!(mutate(&f.db, &duplicate).unwrap_err().code, "CONFLICT");
    f.execute(
        "folder.create",
        json!({"folder":{"id":"kf","name":"Papers","scope":"chats","categoryId":"k","order":0}}),
    );
    // A project and a standalone conversation share the custom category root.
    f.execute("tree.move", json!({"target":{"kind":"project","id":f.project},"scope":"chats","categoryId":"k","order":1}));
    f.execute(
        "tree.move",
        json!({"target":{"kind":"session","id":chat},"scope":"chats","categoryId":"k","order":2}),
    );
    // ...and a folder of that category holds both.
    f.execute(
        "tree.move",
        json!({"target":{"kind":"session","id":chat},"scope":"chats","folderId":"kf","order":0}),
    );
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["projectNavigation"][0]["categoryId"], "k");
    assert!(state["navigation"][0].get("categoryId").is_none());
    assert_eq!(state["navigation"][0]["folderId"], "kf");
    // The Projects built-in accepts conversations too (scope projects).
    f.execute("tree.move", json!({"target":{"kind":"session","id":chat},"scope":"projects","categoryId":"projects","order":0}));
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["navigation"][0]["categoryId"], "projects");
    assert!(state["navigation"][0].get("folderId").is_none());
    // A destination folder from another category is rejected.
    let wrong = f.command("tree.move", json!({"target":{"kind":"session","id":chat},"scope":"chats","folderId":"kf","categoryId":"chats","order":0}));
    assert_eq!(mutate(&f.db, &wrong).unwrap_err().code, "INVALID_ARGUMENT");
    let unknown = f.command("tree.move", json!({"target":{"kind":"session","id":chat},"scope":"chats","categoryId":"missing","order":0}));
    assert_eq!(mutate(&f.db, &unknown).unwrap_err().code, "NOT_FOUND");
    f.execute(
        "tree.move",
        json!({"target":{"kind":"session","id":chat},"scope":"chats","categoryId":"k","order":3}),
    );
    let removed = f.execute("category.remove", json!({"categoryId":"k"}));
    assert_eq!(removed["categories"].as_array().unwrap().len(), 0);
    assert_eq!(removed["folders"][0]["categoryId"], "chats");
    assert_eq!(removed["navigation"][0]["categoryId"], "chats");
    assert_eq!(removed["projectNavigation"][0]["categoryId"], "projects");
    assert_eq!(removed["navigation"][0]["sessionId"], chat);
}

#[test]
fn category_moves_carry_nested_folders_and_removal_keeps_root_category() {
    let f = Fixture::new();
    f.execute(
        "category.create",
        json!({"category":{"id":"k","name":"K","order":0}}),
    );
    f.execute(
        "folder.create",
        json!({"folder":{"id":"a","name":"A","scope":"chats","order":0}}),
    );
    f.execute(
        "folder.create",
        json!({"folder":{"id":"b","name":"B","scope":"chats","parentId":"a","order":0}}),
    );
    f.execute(
        "tree.move",
        json!({"target":{"kind":"folder","id":"a"},"scope":"chats","categoryId":"k","order":0}),
    );
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["folders"][0]["categoryId"], "k");
    assert_eq!(state["folders"][1]["categoryId"], "k");
    // Renaming through folder.update cannot silently change the category.
    let sneaky = f.command(
        "folder.update",
        json!({"folder":{"id":"a","name":"A","scope":"chats","categoryId":"chats","order":0}}),
    );
    assert_eq!(mutate(&f.db, &sneaky).unwrap_err().code, "INVALID_ARGUMENT");
    // Removing a root folder keeps its children in the same category.
    let chat = standalone(&f, "Inside");
    f.execute(
        "tree.move",
        json!({"target":{"kind":"session","id":chat},"scope":"chats","folderId":"a","order":0}),
    );
    let state = f.execute("folder.remove", json!({"folderId":"a"}));
    assert_eq!(state["navigation"][0]["categoryId"], "k");
    assert!(state["navigation"][0].get("folderId").is_none());
    assert!(state["folders"][0].get("parentId").is_none());
    assert_eq!(state["folders"][0]["categoryId"], "k");
}

#[test]
fn legacy_trees_without_categories_load_and_keep_their_placement() {
    let f = Fixture::new();
    let chat = standalone(&f, "Legacy");
    f.execute(
        "folder.create",
        json!({"folder":{"id":"old","name":"Old projects","scope":"projects","order":0}}),
    );
    f.execute("tree.move", json!({"target":{"kind":"project","id":f.project},"scope":"projects","folderId":"old","order":0}));
    // Older snapshots have no categories collection; it loads as empty.
    assert_eq!(
        snapshot(&f.db, &json!({})).unwrap()["categories"],
        json!([])
    );
    // A legacy project folder now also holds a conversation.
    f.execute("tree.move", json!({"target":{"kind":"session","id":chat},"scope":"projects","folderId":"old","order":1}));
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["navigation"][0]["folderId"], "old");
    assert_eq!(state["projectNavigation"][0]["folderId"], "old");
}

#[test]
fn favourites_of_projects_and_project_chats_persist_and_reload_unchanged() {
    let f = Fixture::new();
    // Rows written before the flag existed carry no `favorite` and read as not favourite.
    let placed = f.execute(
        "tree.move",
        json!({"target":{"kind":"project","id":f.project},"scope":"projects","order":4}),
    );
    assert!(placed["projectNavigation"][0].get("favorite").is_none());
    let starred = f.execute(
        "project.favorite",
        json!({"projectId":f.project,"favorite":true}),
    );
    assert_eq!(starred["projectNavigation"][0]["favorite"], true);
    assert_eq!(starred["projectNavigation"][0]["order"], 4, "order is kept");
    let cleared = f.execute(
        "project.favorite",
        json!({"projectId":f.project,"favorite":false}),
    );
    assert_eq!(cleared["projectNavigation"][0]["favorite"], false);
    // A project with no row yet gets one at the order the caller saw.
    let again = f.execute(
        "project.favorite",
        json!({"projectId":f.project,"favorite":true,"order":2}),
    );
    assert_eq!(again["projectNavigation"].as_array().unwrap().len(), 1);
    // A project chat's favourite is the existing navigation row flag.
    let chat = f.execute(
        "navigation.update",
        json!({"navigation":{"sessionId":f.session,"order":0,"favorite":true}}),
    );
    assert_eq!(chat["navigation"][0]["favorite"], true);
    check_session_scope(&f.db, &json!(f.session), &json!(f.project)).unwrap();
    let db = Database::open(&f._dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(snapshot(&db, &json!({})).unwrap(), chat);
}

#[test]
fn project_favourite_rejects_unknown_projects_and_bad_flags() {
    let f = Fixture::new();
    let before = snapshot(&f.db, &json!({})).unwrap();
    for fields in [
        json!({"projectId":"missing","favorite":true}),
        json!({"projectId":f.project,"favorite":"yes"}),
        json!({"projectId":f.project}),
    ] {
        let command = f.command("project.favorite", fields);
        assert!(mutate(&f.db, &command).is_err());
    }
    assert_eq!(snapshot(&f.db, &json!({})).unwrap(), before);
}

#[test]
fn categories_reorder_including_built_ins_and_removal_prunes_the_order() {
    let f = Fixture::new();
    f.execute(
        "category.create",
        json!({"category":{"id":"k","name":"Reading","order":0}}),
    );
    assert!(snapshot(&f.db, &json!({}))
        .unwrap()
        .get("categoryOrder")
        .is_none());
    let state = f.execute(
        "category.reorder",
        json!({"categoryIds":["k","projects","chats"]}),
    );
    assert_eq!(state["categoryOrder"], json!(["k", "projects", "chats"]));
    let unknown = f.command("category.reorder", json!({"categoryIds":["k","missing"]}));
    assert_eq!(mutate(&f.db, &unknown).unwrap_err().code, "NOT_FOUND");
    let duplicate = f.command("category.reorder", json!({"categoryIds":["k","k"]}));
    assert_eq!(
        mutate(&f.db, &duplicate).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let removed = f.execute("category.remove", json!({"categoryId":"k"}));
    assert_eq!(removed["categoryOrder"], json!(["projects", "chats"]));
}
