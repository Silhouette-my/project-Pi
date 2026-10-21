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
