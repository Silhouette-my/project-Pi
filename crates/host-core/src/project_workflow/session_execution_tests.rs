use super::*;

fn create_session_work(f: &Fixture, acceptance: Value) {
    f.execute("workstream.create", json!({"workstream":{
        "id":"w","projectId":f.project,"title":"Repository task","goal":"Use the current Agent session",
        "executionMode":"session","acceptance":acceptance,"owner":{"kind":"user","ref":"local"},
        "status":"draft","priority":0,"order":0,"dependencyIds":[],"nextAction":"Fix and check",
        "mainSessionId":f.session,"revision":0,"decisionRevision":0,"createdAt":"now","updatedAt":"now"
    }}));
}

fn session_run(f: &Fixture, state: &Value) -> Value {
    json!({"id":"session-run","projectId":f.project,"workstreamId":"w","sessionId":f.session,
        "executor":"agent-host","executionMode":"session","workstreamRevision":state["workstreams"][0]["revision"],
        "decisionRevision":0,"state":"executing","outcome":"","effects":[],"startedAt":"now","updatedAt":"now"})
}

#[test]
fn session_execution_is_explicit_durable_and_does_not_capture_bounded_scope() {
    let f = Fixture::new();
    create_session_work(&f, json!([]));
    let ready = f.transition("ready");
    let run = session_run(&f, &ready);
    f.execute("run.start", json!({"run":run}));
    let reopened = Database::open(&f._dir.path().join("pi.sqlite")).unwrap();
    let state = snapshot(&reopened, &json!({})).unwrap();
    assert_eq!(state["workstreams"][0]["executionMode"], "session");
    assert_eq!(state["runs"][0]["executionMode"], "session");
    assert!(state["runs"][0].get("authorizationId").is_none());
    assert_eq!(
        f.db.conn()
            .query_row("SELECT COUNT(*) FROM workflow_run_scopes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let call: crate::tools::ToolsExecuteParams = serde_json::from_value(json!({
        "sessionId":f.session,"mode":"agent","toolCallId":"ordinary-search","toolName":"Glob","args":{"pattern":"**/*"}
    })).unwrap();
    assert!(
        tool_scope::authorize_tool(&f.db, &call).unwrap().is_none(),
        "session execution follows ordinary Host tool permissions"
    );
    assert!(
        tool_scope::prepare_binding(&f.db, &f.session, "session-run").is_err(),
        "a session run cannot impersonate bounded admission"
    );
}

#[test]
fn session_task_completion_does_not_satisfy_optional_acceptance() {
    let f = Fixture::new();
    create_session_work(
        &f,
        json!([{"id":"review","title":"User review","status":"pending","evidenceIds":[]} ]),
    );
    let ready = f.transition("ready");
    f.execute("run.start", json!({"run":session_run(&f, &ready)}));
    let finish = f.command("workstream.transition", json!({"projectId":f.project,"workstreamId":"w","status":"completed","nextAction":"Finished"}));
    assert_eq!(mutate(&f.db, &finish).unwrap_err().code, "CONFLICT");
    f.execute(
        "run.observe",
        json!({"projectId":f.project,"workstreamId":"w","runId":"session-run","state":"completed",
        "outcome":"Fixed and checked.","effects":[],"completionKey":"session-run:terminal"}),
    );
    let completed = f.transition("completed");
    assert_eq!(
        completed["workstreams"][0]["acceptance"][0]["status"],
        "pending"
    );
    assert!(rows(&completed, "evidence").is_empty());
    assert!(rows(&completed, "artifacts").is_empty());
    let renamed = f.execute(
        "workstream.update",
        json!({"projectId":f.project,"workstreamId":"w","patch":{"title":"Renamed finished task"}}),
    );
    assert_eq!(
        renamed["workstreams"][0]["status"], "completed",
        "optional pending acceptance must not reopen a session task"
    );
    f.candidate("optional-candidate");
    f.execute("workstream.update", json!({"projectId":f.project,"workstreamId":"w","patch":{"currentCandidateId":"optional-candidate"}}));
    let feedback = f.execute("feedback.add", json!({"feedback":{"id":"optional-feedback","projectId":f.project,"workstreamId":"w",
        "candidateId":"optional-candidate","candidateRevision":"optional-candidate","environment":"local","acceptanceId":"review",
        "comment":"Optional acceptance needs another look","source":{"kind":"user","ref":"review"},"createdAt":"now"}}));
    assert_eq!(
        feedback["workstreams"][0]["acceptance"][0]["status"],
        "reopened"
    );
    assert_eq!(
        feedback["workstreams"][0]["status"], "completed",
        "feedback does not change a session task's execution receipt"
    );
}

#[test]
fn legacy_work_never_inherits_session_execution_or_loses_its_authorization_requirement() {
    let f = Fixture::new();
    f.create_work();
    let ready = f.transition("ready");
    let mut run = session_run(&f, &ready);
    let marked = f.command("run.start", json!({"run":run}));
    assert_eq!(mutate(&f.db, &marked).unwrap_err().code, "INVALID_ARGUMENT");
    run.as_object_mut().unwrap().remove("executionMode");
    let missing_auth = f.command("run.start", json!({"run":run}));
    assert_eq!(
        mutate(&f.db, &missing_auth).unwrap_err().code,
        "UNAUTHORIZED"
    );
    let change = f.command(
        "workstream.update",
        json!({"projectId":f.project,"workstreamId":"w","patch":{"executionMode":"session"}}),
    );
    assert_eq!(mutate(&f.db, &change).unwrap_err().code, "INVALID_ARGUMENT");
    let state = snapshot(&f.db, &json!({})).unwrap();
    assert!(state["workstreams"][0].get("executionMode").is_none());
    assert!(rows(&state, "runs").is_empty());
}

#[test]
fn session_execution_refuses_bound_authorization_and_unknown_completion() {
    let f = Fixture::new();
    create_session_work(&f, json!([]));
    let ready = f.transition("ready");
    let mut run = session_run(&f, &ready);
    run["authorizationId"] = json!("not-a-session-policy");
    let mixed = f.command("run.start", json!({"run":run}));
    assert_eq!(mutate(&f.db, &mixed).unwrap_err().code, "INVALID_ARGUMENT");
    run.as_object_mut().unwrap().remove("authorizationId");
    f.execute("run.start", json!({"run":run}));
    f.execute("run.observe", json!({"projectId":f.project,"workstreamId":"w","runId":"session-run","state":"completed",
        "outcome":"Command outcome uncertain","effects":[{"id":"shell","action":"tool:Bash","resource":"message:shell","state":"unknown","detail":"No exit receipt"}],"completionKey":"session-run:terminal"}));
    let finish = f.command("workstream.transition", json!({"projectId":f.project,"workstreamId":"w","status":"completed","nextAction":"Finished"}));
    assert_eq!(mutate(&f.db, &finish).unwrap_err().code, "CONFLICT");
}
