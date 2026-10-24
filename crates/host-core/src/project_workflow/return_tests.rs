use super::*;

fn side(f: &Fixture, policy: &str, relation: &str) -> String {
    let session = crate::sessions::create_session(
        &f.db,
        Some("Side".into()),
        None,
        None,
        None,
        Some(f._dir.path().to_string_lossy().into_owned()),
    )
    .unwrap()
    .id;
    f.execute(
        "conversation.link",
        json!({"conversation":{
        "sessionId":session,"projectId":f.project,"workstreamId":"w","relation":relation,
        "parentSessionId":f.session,"sourceRevision":0,"purpose":"ask","visibility":"project",
        "readContext":{"resourceIds":[],"includeDecisions":false,"includeArtifacts":false},
        "returnPolicy":policy,"archived":false,"order":0}}),
    );
    session
}

fn policy(f: &Fixture, session: &str, value: &str) -> Value {
    f.command(
        "conversation.policy",
        json!({"projectId":f.project,"workstreamId":"w","sessionId":session,"returnPolicy":value}),
    )
}

#[test]
fn return_policy_is_mutable_through_its_own_command_only() {
    let f = Fixture::new();
    f.create_work();
    let session = side(&f, "none", "child");
    let before = snapshot(&f.db, &json!({})).unwrap()["conversations"][0].clone();
    // The generic link still cannot rewrite it.
    let mut link = before.clone();
    link["returnPolicy"] = json!("proposal");
    let link = f.command("conversation.link", json!({"conversation":link}));
    assert_eq!(mutate(&f.db, &link).unwrap_err().code, "CONFLICT");

    let state = mutate(&f.db, &policy(&f, &session, "delivery")).unwrap()["snapshot"].clone();
    let after = &state["conversations"][0];
    assert_eq!(after["returnPolicy"], "delivery");
    for key in [
        "parentSessionId",
        "relation",
        "purpose",
        "readContext",
        "sourceRevision",
    ] {
        assert_eq!(after[key], before[key], "{key} must stay immutable");
    }
    let reopened = Database::open(&f._dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(
        snapshot(&reopened, &json!({})).unwrap()["conversations"][0]["returnPolicy"],
        "delivery"
    );
}

#[test]
fn return_policy_rejects_main_unknown_and_invalid_values() {
    let f = Fixture::new();
    f.create_work();
    let main = side(&f, "delivery", "main");
    assert_eq!(
        mutate(&f.db, &policy(&f, &main, "none")).unwrap_err().code,
        "CONFLICT"
    );
    let child = side(&f, "none", "child");
    assert_eq!(
        mutate(&f.db, &policy(&f, &child, "everything"))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        mutate(&f.db, &policy(&f, "missing", "proposal"))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    let mut other = policy(&f, &child, "proposal");
    other["workstreamId"] = json!("other");
    assert!(mutate(&f.db, &other).is_err());
}

fn ret(f: &Fixture, session: &str, id: &str) -> Value {
    f.command(
        "conversation.return",
        json!({"projectId":f.project,"workstreamId":"w","sessionId":session,"recordId":id,
            "title":"Spacing holds in dark","text":"Keep 6px.","createdAt":"2026-10-24T00:00:00Z"}),
    )
}

#[test]
fn returning_follows_the_stored_policy() {
    let f = Fixture::new();
    f.create_work();
    let session = side(&f, "none", "child");
    assert_eq!(
        mutate(&f.db, &ret(&f, &session, "r0")).unwrap_err().code,
        "CONFLICT",
        "none returns nothing"
    );

    mutate(&f.db, &policy(&f, &session, "proposal")).unwrap();
    let state = mutate(&f.db, &ret(&f, &session, "r1")).unwrap()["snapshot"].clone();
    let decision = &state["decisions"][0];
    assert_eq!(decision["state"], "proposed");
    assert_eq!(decision["statement"], "Keep 6px.");
    assert_eq!(decision["sources"][0]["kind"], "session");
    assert_eq!(decision["sources"][0]["ref"], json!(session));
    assert!(rows(&state, "artifacts").is_empty());

    mutate(&f.db, &policy(&f, &session, "delivery")).unwrap();
    let before = snapshot(&f.db, &json!({})).unwrap()["workstreams"][0]["revision"]
        .as_u64()
        .unwrap();
    let state = mutate(&f.db, &ret(&f, &session, "r2")).unwrap()["snapshot"].clone();
    let artifact = &state["artifacts"][0];
    assert_eq!(artifact["kind"], "report");
    assert_eq!(artifact["source"]["ref"], json!(session));
    assert_eq!(
        state["workstreams"][0]["revision"].as_u64().unwrap(),
        before + 1
    );
    assert_eq!(rows(&state, "decisions").len(), 1);

    // A record identity is never reused.
    assert_eq!(
        mutate(&f.db, &ret(&f, &session, "r2")).unwrap_err().code,
        "CONFLICT"
    );
}

#[test]
fn returning_rejects_the_main_conversation_and_empty_text() {
    let f = Fixture::new();
    f.create_work();
    let main = side(&f, "delivery", "main");
    assert_eq!(
        mutate(&f.db, &ret(&f, &main, "m")).unwrap_err().code,
        "CONFLICT"
    );
    let child = side(&f, "proposal", "child");
    let mut empty = ret(&f, &child, "e");
    empty["text"] = json!("  ");
    assert_eq!(mutate(&f.db, &empty).unwrap_err().code, "INVALID_ARGUMENT");
}
