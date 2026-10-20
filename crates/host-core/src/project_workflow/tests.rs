use super::*;

struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    project: String,
    session: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let group = db
            .create_project_group("Workflow project", std::slice::from_ref(&root))
            .unwrap();
        let session = crate::sessions::create_session(
            &db,
            Some("Main chat".into()),
            None,
            None,
            None,
            Some(root),
        )
        .unwrap();
        Self {
            _dir: dir,
            db,
            project: group.id,
            session: session.id,
        }
    }
    fn execute(&self, kind: &str, fields: Value) -> Value {
        let state = snapshot(&self.db, &json!({})).unwrap();
        let mut command = fields;
        command["kind"] = json!(kind);
        command["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        command["expectedRevision"] = state["revision"].clone();
        mutate(&self.db, &command).unwrap()["snapshot"].clone()
    }
    fn create_work(&self) -> Value {
        self.execute("workstream.create",json!({"workstream":{
            "id":"w","projectId":self.project,"title":"Ship search","goal":"Find the right message",
            "acceptance":[{"id":"a","title":"Message jump works","status":"pending","evidenceIds":[]}],
            "owner":{"kind":"user","ref":"local"},"status":"draft","priority":0,"order":0,
            "dependencyIds":[],"nextAction":"Implement search","revision":0,"decisionRevision":0,
            "createdAt":"now","updatedAt":"now"}}))
    }
    fn scope(&self) -> Value {
        json!({"projectId":self.project,"workstreamId":"w"})
    }
    fn transition(&self, status: &str) -> Value {
        let mut scope = self.scope();
        scope["status"] = json!(status);
        scope["nextAction"] = json!("Next");
        self.execute("workstream.transition", scope)
    }
    fn start(&self) -> Value {
        self.execute("authorization.grant",json!({"authorization":{"id":"auth","projectId":self.project,"workstreamId":"w",
            "actions":["edit"],"resources":["src"],"source":{"kind":"user","ref":"local"},"permissionCeiling":"ask","maxRuns":3,"stopConditions":[],"revoked":false}}));
        let state = self.transition("ready");
        self.execute("run.start",json!({"run":{"id":"run","projectId":self.project,"workstreamId":"w","sessionId":self.session,"executor":"local",
            "workstreamRevision":state["workstreams"][0]["revision"],"decisionRevision":0,"authorizationId":"auth","state":"executing",
            "outcome":"","effects":[],"startedAt":"now","updatedAt":"now"}}))
    }
    fn candidate(&self, id: &str) -> Value {
        self.execute("artifact.put",json!({"artifact":{"id":id,"projectId":self.project,"workstreamId":"w","label":"Search build",
            "kind":"candidate","revision":id,"environment":"local","entryPoint":"file:///candidate","source":{"kind":"user","ref":"local"},"createdAt":"now"}}))
    }
    fn command(&self, kind: &str, mut fields: Value) -> Value {
        fields["kind"] = json!(kind);
        fields["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        fields["expectedRevision"] = snapshot(&self.db, &json!({})).unwrap()["revision"].clone();
        fields
    }
}

#[test]
fn workflow_cas_dedupe_is_durable_and_failed_commands_are_atomic() {
    let fixture = Fixture::new();
    assert_eq!(snapshot(&fixture.db, &json!({})).unwrap()["revision"], 0);
    let command = fixture.command(
        "folder.create",
        json!({"folder":{"id":"f","name":"Chats","order":0}}),
    );
    let first = mutate(&fixture.db, &command).unwrap();
    let replay = mutate(&fixture.db, &command).unwrap();
    assert_eq!(first["snapshot"], replay["snapshot"]);
    assert_eq!(replay["replayed"], true);
    let mut collision = command.clone();
    collision["folder"]["name"] = json!("Other");
    assert_eq!(
        mutate(&fixture.db, &collision).unwrap_err().code,
        "CONFLICT"
    );
    let stale =
        json!({"kind":"folder.remove","commandId":"stale","expectedRevision":0,"folderId":"f"});
    let error = mutate(&fixture.db, &stale).unwrap_err();
    assert_eq!(
        error.conflict.unwrap(),
        json!({"expectedRevision":0,"actualRevision":1})
    );
    let missing = fixture.command(
        "navigation.move",
        json!({"sessionIds":[fixture.session,"missing"],"folderId":"f"}),
    );
    assert_eq!(mutate(&fixture.db, &missing).unwrap_err().code, "NOT_FOUND");
    assert!(rows(&snapshot(&fixture.db, &json!({})).unwrap(), "navigation").is_empty());
    let path = fixture._dir.path().join("pi.sqlite");
    drop(fixture.db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(mutate(&reopened, &command).unwrap()["replayed"], true);
}

#[test]
fn workflow_replay_returns_current_snapshot_without_reapplying_command() {
    let f = Fixture::new();
    let original = f.command(
        "folder.create",
        json!({"folder":{"id":"f","name":"First","order":0}}),
    );
    mutate(&f.db, &original).unwrap();
    let current = f.execute(
        "folder.update",
        json!({"folder":{"id":"f","name":"Renamed","order":1}}),
    );
    assert_eq!(current["revision"], 2);
    let replay = mutate(&f.db, &original).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["snapshot"], current);
    assert_eq!(snapshot(&f.db, &json!({})).unwrap(), current);
    assert_eq!(
        f.db.conn()
            .query_row("SELECT COUNT(*) FROM project_workflow_commands", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
    // Original outcome remains durable even though the API returns current state.
    let original_result: String =
        f.db.conn()
            .query_row(
                "SELECT result_json FROM project_workflow_commands WHERE command_id=?1",
                params![original["commandId"].as_str()],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&original_result).unwrap()["snapshot"]["revision"],
        1
    );
}

#[test]
fn workflow_folders_remove_non_destructively_and_navigation_stays_independent() {
    let f = Fixture::new();
    f.create_work();
    f.execute(
        "folder.create",
        json!({"folder":{"id":"parent","name":"Parent","order":0}}),
    );
    f.execute(
        "folder.create",
        json!({"folder":{"id":"child","name":"Child","parentId":"parent","order":1}}),
    );
    let deep = f.command(
        "folder.create",
        json!({"folder":{"id":"deep","name":"Deep","parentId":"child","order":0}}),
    );
    assert_eq!(mutate(&f.db, &deep).unwrap_err().code, "INVALID_ARGUMENT");
    f.execute(
        "navigation.move",
        json!({"sessionIds":[f.session],"folderId":"parent"}),
    );
    let before = snapshot(&f.db, &json!({})).unwrap()["workstreams"].clone();
    let state = f.execute("folder.remove", json!({"folderId":"parent"}));
    assert!(state["navigation"][0].get("folderId").is_none());
    assert!(state["folders"][0].get("parentId").is_none());
    assert_eq!(before, state["workstreams"]);
    check_session(&f.db, &json!(f.session)).unwrap();
    assert_eq!(
        snapshot(&f.db, &json!({"projectId":f.project,"workstreamId":"w"})).unwrap()["folders"],
        state["folders"]
    );
}

#[test]
fn workflow_boundary_rejects_unknown_fields_invalid_shapes_and_unknown_projects() {
    let f = Fixture::new();
    for fields in [
        json!({"folder":{"id":"f","name":"ok","order":0,"extra":true}}),
        json!({"folder":{"id":"","name":"ok","order":0}}),
    ] {
        assert_eq!(
            mutate(&f.db, &f.command("folder.create", fields))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    assert_eq!(
        snapshot(&f.db, &json!({"projectId":"missing"}))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_eq!(
        search(&f.db, &json!({"query":"x","limit":0}))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(snapshot(&f.db, &json!({})).unwrap()["revision"], 0);
}

#[test]
fn workflow_runs_are_not_acceptance_and_decisions_fence_stale_delivery() {
    let f = Fixture::new();
    f.create_work();
    f.start();
    let mut observation = f.scope();
    observation["runId"] = json!("run");
    observation["state"] = json!("completed");
    observation["outcome"] = json!("Produced build");
    observation["effects"] = json!([]);
    observation["completionKey"] = json!("turn-1");
    let observed = f.execute("run.observe", observation);
    assert_ne!(observed["workstreams"][0]["status"], "completed");
    f.execute("decision.propose",json!({"decision":{"id":"d","projectId":f.project,"workstreamId":"w","title":"Use lexical search","statement":"No embeddings",
        "state":"proposed","sources":[{"kind":"user","ref":"local"}],"createdAt":"now"}}));
    let mut resolve = f.scope();
    resolve["decisionId"] = json!("d");
    resolve["resolution"] = json!("adopt");
    resolve["source"] = json!({"kind":"user","ref":"local"});
    let adopted = f.execute("decision.resolve", resolve);
    assert_eq!(adopted["workstreams"][0]["decisionRevision"], 1);
    let delivery=f.execute("delivery.publish",json!({"delivery":{"id":"delivery","projectId":f.project,"workstreamId":"w","sourceRunId":"run","kind":"result",
        "summary":"Old result","artifactIds":[],"sources":[],"decisionRevision":0,"state":"delivered","disposition":"pending","createdAt":"now"}}));
    assert_eq!(delivery["deliveries"][0]["disposition"], "stale");
    let mut consume = f.scope();
    consume["deliveryId"] = json!("delivery");
    consume["disposition"] = json!("integrated");
    let consumed = f.execute("delivery.consume", consume);
    assert_eq!(consumed["deliveries"][0]["state"], "consumed");
    assert_eq!(consumed["deliveries"][0]["disposition"], "stale");
    assert_eq!(consumed["decisions"][0]["state"], "effective");
    let mut complete = f.scope();
    complete["status"] = json!("completed");
    complete["nextAction"] = json!("");
    assert_eq!(
        mutate(&f.db, &f.command("workstream.transition", complete))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
}

#[test]
fn workflow_feedback_reopens_only_exact_candidate_and_retains_evidence() {
    let f = Fixture::new();
    f.create_work();
    f.candidate("candidate-1");
    let mut update = f.scope();
    update["patch"] = json!({"currentCandidateId":"candidate-1"});
    f.execute("workstream.update", update);
    let evidence = json!({"id":"ev","projectId":f.project,"workstreamId":"w","candidateId":"candidate-1","candidateRevision":"candidate-1","environment":"local",
        "scenario":"message jump","acceptanceId":"a","outcome":"passed","kind":"integration","limits":"No live account","source":{"kind":"user","ref":"local"},"createdAt":"now"});
    f.execute("evidence.add", json!({"evidence":evidence}));
    let mut accept = f.scope();
    accept["patch"] = json!({"acceptance":[{"id":"a","title":"Message jump works","status":"satisfied","evidenceIds":["ev"]}]});
    f.execute("workstream.update", accept);
    f.transition("ready");
    f.transition("completed");
    let feedback = json!({"id":"feedback","projectId":f.project,"workstreamId":"w","candidateId":"candidate-1","candidateRevision":"candidate-1","environment":"local",
        "acceptanceId":"a","comment":"Wrong message after restart","source":{"kind":"user","ref":"local"},"createdAt":"now"});
    let mut wrong = feedback.clone();
    wrong["candidateRevision"] = json!("wrong");
    assert_eq!(
        mutate(&f.db, &f.command("feedback.add", json!({"feedback":wrong})))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let reopened = f.execute("feedback.add", json!({"feedback":feedback}));
    assert_eq!(
        reopened["workstreams"][0]["acceptance"][0]["status"],
        "reopened"
    );
    assert_eq!(reopened["evidence"][0]["outcome"], "passed");
    assert_eq!(reopened["workstreams"][0]["status"], "ready");
}

#[test]
fn workflow_search_uses_existing_messages_breadcrumbs_and_side_visibility() {
    let f = Fixture::new();
    f.create_work();
    let message:crate::sessions::UiMessage=serde_json::from_value(json!({"id":"needle-message","role":"user","content":"Exact retrieval needle","createdAt":"2026-10-20T00:00:00Z"})).unwrap();
    crate::sessions::append_message(&f.db, &f.session, &message, None).unwrap();
    f.execute("conversation.link",json!({"conversation":{"sessionId":f.session,"projectId":f.project,"workstreamId":"w","sourceRevision":0,"relation":"main",
        "purpose":"ask","visibility":"side_only","readContext":{"resourceIds":[],"includeDecisions":false,"includeArtifacts":false},"returnPolicy":"none","archived":true,"order":0}}));
    assert_eq!(
        search(&f.db, &json!({"query":"needle","projectId":f.project})).unwrap()["hits"],
        json!([])
    );
    let result = search(&f.db, &json!({"query":"needle","sessionId":f.session})).unwrap();
    assert_eq!(result["hits"][0]["messageId"], "needle-message");
    assert_eq!(
        result["hits"][0]["breadcrumb"],
        json!(["Workflow project", "Ship search", "Main chat"])
    );
    assert_eq!(
        search(&f.db, &json!({"query":"Ship search","projectId":f.project})).unwrap()["hits"][0]
            ["kind"],
        "workstream"
    );
}

#[test]
fn workflow_populated_v24_migration_preserves_canonical_state_and_restart() {
    let f = Fixture::new();
    let path = f._dir.path().join("pi.sqlite");
    f.db.kv_set("test", "preserved", &json!({"value":42}))
        .unwrap();
    let message:crate::sessions::UiMessage=serde_json::from_value(json!({"id":"migration-message","role":"user","content":"Migration preserves message content","createdAt":"2026-10-20T00:00:00Z"})).unwrap();
    crate::sessions::append_message(&f.db, &f.session, &message, None).unwrap();
    f.db.set_project_group_instructions(&f.project, "Keep canonical instructions")
        .unwrap();
    f.db.conn().execute_batch("DROP TABLE project_workflow_commands; DROP TABLE project_workflow; PRAGMA user_version=24;").unwrap();
    drop(f.db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
    assert_eq!(
        db.kv_get("test", "preserved").unwrap(),
        Some(json!({"value":42}))
    );
    assert!(db
        .list_project_groups()
        .unwrap()
        .iter()
        .any(|p| p.id == f.project));
    check_session(&db, &json!(f.session)).unwrap();
    assert_eq!(
        db.get_project_group_instructions(&f.project).unwrap(),
        "Keep canonical instructions"
    );
    let found = search(
        &db,
        &json!({"query":"Migration preserves","projectId":f.project}),
    )
    .unwrap();
    assert_eq!(found["hits"][0]["messageId"], "migration-message");
    assert_eq!(snapshot(&db, &json!({})).unwrap()["revision"], 0);
    assert!(crate::db::migration_backup_path(&path, 24).exists());
}

#[test]
fn workflow_unknown_effect_cannot_be_replayed_and_unrelated_work_survives() {
    let f = Fixture::new();
    f.create_work();
    f.start();
    let mut observed = f.scope();
    observed["runId"] = json!("run");
    observed["state"] = json!("unknown");
    observed["outcome"] = json!("Connection lost");
    observed["effects"] = json!([{"id":"effect","action":"deploy","resource":"remote","state":"unknown","detail":"May have applied"}]);
    f.execute("run.observe", observed.clone());
    observed["state"] = json!("executing");
    assert_eq!(
        mutate(&f.db, &f.command("run.observe", observed))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let mut paused = f.scope();
    paused["status"] = json!("paused");
    paused["nextAction"] = json!("Reconcile effect");
    f.execute("workstream.transition", paused);
    assert_eq!(
        snapshot(&f.db, &json!({})).unwrap()["runs"][0]["state"],
        "unknown"
    );
}

#[test]
fn workflow_parallel_connections_use_one_atomic_revision() {
    let f = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let path = f._dir.path().join("pi.sqlite");
    let mut threads = vec![];
    for id in ["first", "second"] {
        let db = Database::open(&path).unwrap();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            mutate(&db,&json!({"kind":"folder.create","commandId":id,"expectedRevision":0,"folder":{"id":id,"name":id,"order":0}}))
        }));
    }
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results.iter().find_map(|r| r.as_ref().err()).unwrap().code,
        "CONFLICT"
    );
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert_eq!(state["revision"], 1);
    assert_eq!(rows(&state, "folders").len(), 1);
}

#[test]
fn workflow_resources_decisions_navigation_and_delivery_roundtrip() {
    let f = Fixture::new();
    f.create_work();
    f.start();
    f.execute(
        "folder.create",
        json!({"folder":{"id":"f","name":"First","order":0}}),
    );
    f.execute(
        "folder.update",
        json!({"folder":{"id":"f","name":"Renamed","order":2}}),
    );
    f.execute("navigation.update",json!({"navigation":{"sessionId":f.session,"folderId":"f","order":3,"favorite":true,"lastAccessedAt":"now"}}));
    f.execute("navigation.expand", json!({"expandedIds":["f","w"]}));
    f.execute("resource.put",json!({"resource":{"id":"resource","projectId":f.project,"label":"Source policy","uri":"file:///policy","kind":"constraint","revision":"1","updatedAt":"now","state":"effective","source":{"kind":"user","ref":"local"}}}));
    let proposed = |id: &str, supersedes: Option<&str>| {
        let mut row = json!({"id":id,"projectId":f.project,"workstreamId":"w","title":"Decision needle","statement":"Use host persistence","state":"proposed","sources":[],"createdAt":"now"});
        if let Some(old) = supersedes {
            row["supersedesId"] = json!(old);
        }
        row
    };
    let resolve = |id: &str, resolution: &str| {
        let mut scope = f.scope();
        scope["decisionId"] = json!(id);
        scope["resolution"] = json!(resolution);
        scope["source"] = json!({"kind":"user","ref":"local"});
        scope
    };
    f.execute("decision.propose", json!({"decision":proposed("d1",None)}));
    f.execute("decision.resolve", resolve("d1", "alternative"));
    f.execute("decision.resolve", resolve("d1", "adopt"));
    f.execute(
        "decision.propose",
        json!({"decision":proposed("d2",Some("d1"))}),
    );
    let state = f.execute("decision.resolve", resolve("d2", "adopt"));
    assert_eq!(state["decisions"][0]["state"], "superseded");
    assert_eq!(state["workstreams"][0]["decisionRevision"], 2);
    let mut delivery = json!({"id":"del","projectId":f.project,"workstreamId":"w","sourceRunId":"run","kind":"result","summary":"Completed bounded assignment","artifactIds":[],"sources":[],"decisionRevision":0,"state":"produced","disposition":"pending","createdAt":"now"});
    f.execute("delivery.publish", json!({"delivery":delivery}));
    delivery["state"] = json!("delivered");
    f.execute("delivery.publish", json!({"delivery":delivery}));
    let subset = snapshot(&f.db, &json!({"projectId":f.project,"workstreamId":"w"})).unwrap();
    assert_eq!(subset["resources"][0]["id"], "resource");
    assert_eq!(subset["navigation"][0]["order"], 3);
    assert_eq!(subset["folders"][0]["name"], "Renamed");
    assert_eq!(
        search(
            &f.db,
            &json!({"query":"Decision needle","workstreamId":"w"})
        )
        .unwrap()["hits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn workflow_workstream_scope_includes_only_its_projects_resources() {
    let f = Fixture::new();
    f.create_work();
    let other_root = f._dir.path().join("other-project");
    std::fs::create_dir(&other_root).unwrap();
    let other =
        f.db.create_project_group(
            "Other project",
            &[other_root.to_string_lossy().into_owned()],
        )
        .unwrap();
    for (id, project) in [
        ("own-resource", f.project.as_str()),
        ("other-resource", other.id.as_str()),
    ] {
        f.execute("resource.put", json!({"resource":{"id":id,"projectId":project,"label":id,
            "uri":"file:///policy","kind":"constraint","revision":"1","updatedAt":"now","state":"effective",
            "source":{"kind":"user","ref":"local"}}}));
    }
    let all = snapshot(&f.db, &json!({})).unwrap();
    let selected = snapshot(&f.db, &json!({"workstreamId":"w"})).unwrap();
    assert_eq!(selected["revision"], all["revision"]);
    assert_eq!(rows(&selected, "resources").len(), 1);
    assert_eq!(selected["resources"][0]["id"], "own-resource");
    assert_eq!(selected["workstreams"][0]["projectId"], f.project);
}

#[test]
fn workflow_adoption_between_production_and_delivery_retains_stale_result() {
    let f = Fixture::new();
    f.create_work();
    f.start();
    let mut delivery = json!({"id":"del","projectId":f.project,"workstreamId":"w","sourceRunId":"run",
        "kind":"result","summary":"Old decision result","artifactIds":[],"sources":[],"decisionRevision":0,
        "state":"produced","disposition":"pending","createdAt":"now"});
    f.execute("delivery.publish", json!({"delivery":delivery}));
    f.execute("decision.propose", json!({"decision":{"id":"d","projectId":f.project,"workstreamId":"w",
        "title":"New decision","statement":"Updated direction","state":"proposed","sources":[],"createdAt":"now"}}));
    let mut resolve = f.scope();
    resolve["decisionId"] = json!("d");
    resolve["resolution"] = json!("adopt");
    resolve["source"] = json!({"kind":"user","ref":"local"});
    f.execute("decision.resolve", resolve);
    delivery["state"] = json!("delivered");
    let delivered = f.execute("delivery.publish", json!({"delivery":delivery}));
    assert_eq!(delivered["deliveries"][0]["state"], "delivered");
    assert_eq!(delivered["deliveries"][0]["disposition"], "stale");
    let mut consume = f.scope();
    consume["deliveryId"] = json!("del");
    consume["disposition"] = json!("integrated");
    let consumed = f.execute("delivery.consume", consume);
    assert_eq!(consumed["deliveries"][0]["state"], "consumed");
    assert_eq!(consumed["deliveries"][0]["disposition"], "stale");
    assert_eq!(consumed["decisions"][0]["state"], "effective");
}

#[test]
fn workflow_completed_work_reopens_when_acceptance_or_candidate_is_invalidated() {
    for invalidation in [
        "pending",
        "reopened",
        "candidate-clear",
        "candidate-replace",
    ] {
        let f = Fixture::new();
        f.create_work();
        f.candidate("candidate-1");
        f.candidate("candidate-2");
        let mut update = f.scope();
        update["patch"] = json!({"currentCandidateId":"candidate-1"});
        f.execute("workstream.update", update);
        f.execute("evidence.add", json!({"evidence":{"id":"ev","projectId":f.project,"workstreamId":"w",
            "candidateId":"candidate-1","candidateRevision":"candidate-1","environment":"local","scenario":"jump",
            "acceptanceId":"a","outcome":"passed","kind":"integration","limits":"No live account",
            "source":{"kind":"user","ref":"local"},"createdAt":"now"}}));
        let mut accept = f.scope();
        accept["patch"] = json!({"acceptance":[{"id":"a","title":"Message jump works","status":"satisfied","evidenceIds":["ev"]}]});
        f.execute("workstream.update", accept);
        f.transition("ready");
        f.transition("completed");
        let mut invalidate = f.scope();
        invalidate["patch"] = match invalidation {
            "candidate-clear" => json!({"currentCandidateId":null}),
            "candidate-replace" => json!({"currentCandidateId":"candidate-2"}),
            status => {
                json!({"acceptance":[{"id":"a","title":"Message jump works","status":status,"evidenceIds":["ev"]}]})
            }
        };
        let state = f.execute("workstream.update", invalidate);
        assert_eq!(state["workstreams"][0]["status"], "ready", "{invalidation}");
        assert_ne!(
            state["workstreams"][0]["acceptance"][0]["status"], "satisfied",
            "{invalidation}"
        );
        assert_eq!(
            state["workstreams"][0]["acceptance"][0]["evidenceIds"],
            json!(["ev"])
        );
        assert_eq!(state["evidence"][0]["outcome"], "passed");
    }
}

#[test]
fn workflow_parallel_side_work_is_session_scoped_but_unknown_effects_fence_its_workstream() {
    fn link(f: &Fixture, session: &str, work: &str, relation: &str) {
        let current = snapshot(&f.db, &json!({"workstreamId":work})).unwrap();
        f.execute("conversation.link", json!({"conversation":{"sessionId":session,"projectId":f.project,
            "workstreamId":work,"sourceRevision":current["workstreams"][0]["revision"],"relation":relation,
            "purpose":"work","visibility":"project","readContext":{"resourceIds":[],"includeDecisions":true,"includeArtifacts":true},
            "returnPolicy":"delivery","archived":false,"order":0}}));
    }
    fn run(f: &Fixture, id: &str, session: &str, work: &str, authorization: &str) -> Value {
        let current = snapshot(&f.db, &json!({"workstreamId":work})).unwrap();
        json!({"id":id,"projectId":f.project,"workstreamId":work,"sessionId":session,"executor":"local",
            "workstreamRevision":current["workstreams"][0]["revision"],"decisionRevision":current["workstreams"][0]["decisionRevision"],
            "authorizationId":authorization,"state":"executing","outcome":"","effects":[],"startedAt":"now","updatedAt":"now"})
    }
    fn session(f: &Fixture) -> String {
        crate::sessions::create_session(
            &f.db,
            None,
            None,
            None,
            None,
            Some(f._dir.path().to_string_lossy().into_owned()),
        )
        .unwrap()
        .id
    }
    let f = Fixture::new();
    f.create_work();
    link(&f, &f.session, "w", "main");
    f.start();
    let side = session(&f);
    link(&f, &side, "w", "child");
    let state = f.execute(
        "run.start",
        json!({"run":run(&f,"side-run",&side,"w","auth")}),
    );
    assert_eq!(rows(&state, "runs").len(), 2);
    assert_eq!(state["runs"][0]["state"], "executing");
    let duplicate = f.command(
        "run.start",
        json!({"run":run(&f,"duplicate-side",&side,"w","auth")}),
    );
    assert_eq!(mutate(&f.db, &duplicate).unwrap_err().code, "CONFLICT");
    // Different sessions share the same authorization budget, not separate allowances.
    let third = session(&f);
    link(&f, &third, "w", "child");
    f.execute(
        "run.start",
        json!({"run":run(&f,"third-run",&third,"w","auth")}),
    );
    let fourth = session(&f);
    link(&f, &fourth, "w", "child");
    let fourth_run = run(&f, "fourth-run", &fourth, "w", "auth");
    assert_eq!(
        mutate(&f.db, &f.command("run.start", json!({"run":fourth_run})))
            .unwrap_err()
            .code,
        "UNAUTHORIZED"
    );
    let mut observed = f.scope();
    observed["runId"] = json!("side-run");
    observed["state"] = json!("completed");
    observed["outcome"] = json!("Turn ended with uncertain external action");
    observed["effects"] = json!([{"id":"uncertain","action":"edit","resource":"src","state":"unknown","detail":"Receipt missing"}]);
    f.execute("run.observe", observed);
    let blocked = mutate(
        &f.db,
        &f.command(
            "run.start",
            json!({"run":run(&f,"blocked-run",&fourth,"w","auth")}),
        ),
    )
    .unwrap_err();
    assert_eq!(blocked.code, "CONFLICT");
    assert!(blocked.message.contains("unknown effect"));
    // A separate workstream remains runnable, with its own linked session and authority.
    let mut work = snapshot(&f.db, &json!({"workstreamId":"w"})).unwrap()["workstreams"][0].clone();
    work["id"] = json!("independent");
    work["revision"] = json!(0);
    work["status"] = json!("ready");
    work.as_object_mut().unwrap().remove("mainSessionId");
    f.execute("workstream.create", json!({"workstream":work}));
    f.execute("authorization.grant",json!({"authorization":{"id":"independent-auth","projectId":f.project,"workstreamId":"independent",
        "actions":["edit"],"resources":["src"],"source":{"kind":"user","ref":"local"},"permissionCeiling":"ask","maxRuns":1,"stopConditions":[],"revoked":false}}));
    let wrong_scope = f.command(
        "run.start",
        json!({"run":run(&f,"wrong-link",&side,"independent","independent-auth")}),
    );
    assert_eq!(
        mutate(&f.db, &wrong_scope).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let independent = session(&f);
    link(&f, &independent, "independent", "main");
    let state = f.execute(
        "run.start",
        json!({"run":run(&f,"independent-run",&independent,"independent","independent-auth")}),
    );
    assert_eq!(
        find(&state, "runs", &json!("independent-run")).unwrap()["state"],
        "executing"
    );
    assert_eq!(
        find(&state, "runs", &json!("run")).unwrap()["state"],
        "executing"
    );
}

#[test]
fn workflow_authority_budget_revocation_and_workspace_mismatch_are_enforced() {
    let f = Fixture::new();
    f.create_work();
    let state = f.start();
    let mut observed = f.scope();
    observed["runId"] = json!("run");
    observed["state"] = json!("failed");
    observed["outcome"] = json!("Stopped");
    observed["effects"] = json!([]);
    f.execute("run.observe", observed);
    let mut revoke = f.scope();
    revoke["authorizationId"] = json!("auth");
    f.execute("authorization.revoke", revoke);
    let mut run = state["runs"][0].clone();
    run["id"] = json!("second-run");
    assert_eq!(
        mutate(&f.db, &f.command("run.start", json!({"run":run})))
            .unwrap_err()
            .code,
        "UNAUTHORIZED"
    );
    let other = f._dir.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let unrelated = crate::sessions::create_session(
        &f.db,
        None,
        None,
        None,
        None,
        Some(other.to_string_lossy().into()),
    )
    .unwrap();
    let mut update = f.scope();
    update["patch"] = json!({"mainSessionId":unrelated.id});
    assert_eq!(
        mutate(&f.db, &f.command("workstream.update", update))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
}
