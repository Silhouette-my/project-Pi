use super::*;
use crate::project_workflow;
use std::fs;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    state: Arc<Mutex<AppState>>,
    session: String,
    project: String,
}
fn mutate(db: &crate::db::Database, kind: &str, mut command: Value) -> Value {
    command["kind"] = json!(kind);
    command["commandId"] = json!(uuid::Uuid::new_v4().to_string());
    command["expectedRevision"] =
        project_workflow::snapshot(db, &json!({})).unwrap()["revision"].clone();
    project_workflow::mutate(db, &command).unwrap()["snapshot"].clone()
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let group = st
            .db
            .create_project_group("Scoped work", &[root.to_string_lossy().into_owned()])
            .unwrap();
        let session = sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &st.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        mutate(
            &st.db,
            "workstream.create",
            json!({"workstream":{"id":"w","projectId":group.id,"title":"Scoped assignment","goal":"Write only output", "acceptance":[],"owner":{"kind":"user","ref":"local"},"status":"ready","priority":0,"order":0,"dependencyIds":[],"nextAction":"Write output","revision":0,"decisionRevision":0,"createdAt":"now","updatedAt":"now"}}),
        );
        mutate(
            &st.db,
            "authorization.grant",
            json!({"authorization":{"id":"auth","projectId":group.id,"workstreamId":"w","actions":["implement"],"resources":["output"],"source":{"kind":"user","ref":"local"},"permissionCeiling":"auto","maxRuns":1,"stopConditions":[],"revoked":false}}),
        );
        mutate(
            &st.db,
            "resource.put",
            json!({"resource":{"id":"policy","projectId":group.id,"workstreamId":"w","label":"Policy","uri":"policy.txt","kind":"constraint","revision":"1","updatedAt":"now","state":"effective","source":{"kind":"user","ref":"local"}}}),
        );
        fs::write(root.join("policy.txt"), "Read-only policy").unwrap();
        let state = project_workflow::snapshot(&st.db, &json!({})).unwrap();
        mutate(
            &st.db,
            "run.start",
            json!({"run":{"id":"run","projectId":group.id,"workstreamId":"w","sessionId":session.id,"executor":"local","workstreamRevision":state["workstreams"][0]["revision"],"decisionRevision":0,"authorizationId":"auth","state":"executing","outcome":"","effects":[{"id":"dispatch","action":"implement","resource":"output","state":"planned","detail":"Typed output assignment"}],"startedAt":"now","updatedAt":"now"}}),
        );
        Self {
            _dir: dir,
            root,
            state: Arc::new(Mutex::new(st)),
            session: session.id,
            project: group.id,
        }
    }
    async fn begin(&self, workflow: bool) -> String {
        let mut params = json!({"sessionId":self.session});
        if workflow {
            params["workflowRunId"] = json!("run");
        }
        handle_request(
            self.state.clone(),
            "session.beginTurn",
            params,
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap()["turnId"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn tool(&self, name: &str, args: Value, turn: Option<&str>) -> Value {
        let mut params = json!({"sessionId":self.session,"toolCallId":uuid::Uuid::new_v4().to_string(),"toolName":name,"args":args,"mode":"agent","permissionScope":"auto"});
        if let Some(turn) = turn {
            params["turnId"] = json!(turn);
        }
        handle_request(
            self.state.clone(),
            "tools.execute",
            params,
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn workflow_tool_boundary_allows_typed_output_and_readonly_inputs_but_denies_other_effects() {
    let f = Fixture::new();
    fs::write(f.root.join("artifact.txt"), "Read-only artifact").unwrap();
    fs::write(f.root.join("offered.txt"), "Read-only delivery source").unwrap();
    {
        let st = f.state.lock().await;
        mutate(
            &st.db,
            "artifact.put",
            json!({"artifact":{"id":"input-artifact","projectId":f.project,"workstreamId":"w",
            "label":"Input report","kind":"report","revision":"1","environment":"local","entryPoint":"artifact.txt",
            "source":{"kind":"user","ref":"local"},"createdAt":"now"}}),
        );
        mutate(
            &st.db,
            "delivery.publish",
            json!({"delivery":{"id":"offered","projectId":f.project,"workstreamId":"w","sourceRunId":"run",
            "kind":"evidence","summary":"Offered source","artifactIds":["input-artifact"],"sources":[{"kind":"file","ref":"offered.txt"}],
            "decisionRevision":0,"state":"delivered","disposition":"pending","createdAt":"now"}}),
        );
    }
    let turn = f.begin(true).await;
    // The allowed output has nonexistent ancestors at dispatch/bind time.
    let written = f
        .tool(
            "Write",
            json!({"path":"output/nested/result.txt","content":"before"}),
            Some(&turn),
        )
        .await;
    assert_eq!(written["ok"], true, "{written}");
    assert_eq!(
        fs::read_to_string(f.root.join("output/nested/result.txt")).unwrap(),
        "before"
    );
    let edited = f
        .tool(
            "Edit",
            json!({"path":"output/nested/result.txt","old_string":"before","new_string":"after"}),
            None,
        )
        .await;
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(f.root.join("output/nested/result.txt")).unwrap(),
        "after"
    );
    assert_eq!(
        f.tool("Read", json!({"path":"policy.txt"}), Some(&turn))
            .await["ok"],
        true
    );
    for path in ["artifact.txt", "offered.txt"] {
        assert_eq!(f.tool("Read", json!({"path":path}), None).await["ok"], true);
        assert_eq!(
            f.tool(
                "Write",
                json!({"path":path,"content":"must not write"}),
                None
            )
            .await["errorCode"],
            "WORKFLOW_RESOURCE_DENIED"
        );
    }
    // Observed tool receipts are facts, not a new dispatch authorization.
    {
        let st = f.state.lock().await;
        mutate(
            &st.db,
            "run.observe",
            json!({"projectId":f.project,"workstreamId":"w","runId":"run","state":"executing","outcome":"",
        "effects":[{"id":"dispatch","action":"implement","resource":"output","state":"planned","detail":"Typed output assignment"},
            {"id":"receipt","action":"tool:Write","resource":"outside.txt","state":"confirmed","detail":"Observed receipt cannot grant authority"}]}),
        );
    }
    for path in ["policy.txt", "outside.txt", "output/../outside.txt"] {
        let denied = f
            .tool(
                "Write",
                json!({"path":path,"content":"must not write"}),
                None,
            )
            .await;
        assert_eq!(denied["errorCode"], "WORKFLOW_RESOURCE_DENIED", "{denied}");
        assert_eq!(denied["ok"], false);
    }
    assert_eq!(
        fs::read_to_string(f.root.join("policy.txt")).unwrap(),
        "Read-only policy"
    );
    assert!(!f.root.join("outside.txt").exists());
    for tool in [
        "Bash",
        "plugin_untrusted",
        "mcp_external",
        "GenerateImages",
        "Task",
        "ScheduledTask",
    ] {
        let denied = f
            .tool(
                tool,
                json!({"command":"touch outside.txt","path":"output/anything","content":"no"}),
                Some(&turn),
            )
            .await;
        assert_eq!(
            denied["errorCode"], "WORKFLOW_RESOURCE_DENIED",
            "{tool}: {denied}"
        );
    }
    assert!(!f.root.join("outside.txt").exists());
    let forged = f
        .tool(
            "Write",
            json!({"path":"output/forged.txt","content":"no"}),
            Some("other-turn"),
        )
        .await;
    assert_eq!(forged["errorCode"], "WORKFLOW_RESOURCE_DENIED");
    assert!(!f.root.join("output/forged.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn workflow_edit_mv_cannot_escape_output_or_overwrite_readonly_or_symlink_targets() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let turn = f.begin(true).await;
    let written = f
        .tool(
            "Write",
            json!({"path":"output/source.txt","content":"source remains"}),
            Some(&turn),
        )
        .await;
    assert_eq!(written["ok"], true, "{written}");
    let tag = written["content"]["tag"].as_str().unwrap();
    fs::write(f.root.join("outside.txt"), "outside remains").unwrap();
    symlink(
        f.root.join("policy.txt"),
        f.root.join("output/target-alias"),
    )
    .unwrap();
    for destination in [
        "outside.txt",
        "../escaped.txt",
        "policy.txt",
        "output/target-alias",
    ] {
        let denied = f
            .tool(
                "Edit",
                json!({"path":"output/source.txt","tag":tag,"ops":format!("MV {destination}")}),
                None,
            )
            .await;
        assert_eq!(
            denied["errorCode"], "WORKFLOW_RESOURCE_DENIED",
            "{destination}: {denied}"
        );
        assert_eq!(
            fs::read_to_string(f.root.join("output/source.txt")).unwrap(),
            "source remains"
        );
        assert_eq!(
            fs::read_to_string(f.root.join("outside.txt")).unwrap(),
            "outside remains"
        );
        assert_eq!(
            fs::read_to_string(f.root.join("policy.txt")).unwrap(),
            "Read-only policy"
        );
        assert!(f
            .root
            .join("output/target-alias")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!f.root.parent().unwrap().join("escaped.txt").exists());
    }
    // A PUT body containing MV text is not a move operation.
    let edit = f
        .tool(
            "Edit",
            json!({"path":"output/source.txt","tag":tag,"ops":"PUT 1.=1:\n+MV policy.txt"}),
            None,
        )
        .await;
    assert_eq!(edit["ok"], true, "{edit}");
    assert_eq!(
        fs::read_to_string(f.root.join("output/source.txt")).unwrap(),
        "MV policy.txt"
    );
    handle_request(
        f.state.clone(),
        "session.endTurn",
        json!({"turnId":turn,"status":"completed","createNotification":false}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let ordinary = f.begin(false).await;
    let moved=f.tool("Edit",json!({"path":"output/source.txt","tag":edit["content"]["tag"],"ops":"MV ordinary-moved.txt"}),Some(&ordinary)).await;
    assert_eq!(moved["ok"], true, "{moved}");
    assert!(!f.root.join("output/source.txt").exists());
    assert_eq!(
        fs::read_to_string(f.root.join("ordinary-moved.txt")).unwrap(),
        "MV policy.txt"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn workflow_file_executor_rejects_a_target_reresolved_after_host_authorization() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let output = root.join("output");
    let other = root.join("other");
    fs::create_dir(&output).unwrap();
    fs::create_dir(&other).unwrap();
    fs::write(output.join("source.txt"), "original output").unwrap();
    fs::write(other.join("source.txt"), "not authorized").unwrap();
    let approved = crate::workspace::resolve_external_path(root, "output/source.txt").unwrap();
    fs::rename(&output, root.join("original-output")).unwrap();
    symlink(&other, &output).unwrap();
    for tool in ["Write", "Read", "Edit"] {
        let result=tools::execute_tool_with_path_access(Some(root),None,tool,&json!({"path":approved,"content":"must not write","old_string":"not authorized","new_string":"must not edit"}),tools::ToolExecutionOptions {
            timeout_ms:None,bash_options:None,allow_external_paths:false,hashline:None,canonical_path_limit:Some(&approved),
        }).await;
        assert_eq!(
            result.error_code.as_deref(),
            Some("WORKFLOW_RESOURCE_DENIED"),
            "{tool}: {result:?}"
        );
        assert_eq!(
            fs::read_to_string(other.join("source.txt")).unwrap(),
            "not authorized"
        );
        assert_eq!(
            fs::read_to_string(root.join("original-output/source.txt")).unwrap(),
            "original output"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn workflow_tool_boundary_resolves_symlink_aliases_and_future_symlink_targets() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let turn = f.begin(true).await;
    fs::create_dir(f.root.join("output")).unwrap();
    fs::create_dir(f.root.join("other")).unwrap();
    symlink(f.root.join("output"), f.root.join("alias")).unwrap();
    let allowed = f
        .tool(
            "Write",
            json!({"path":"alias/allowed.txt","content":"ok"}),
            Some(&turn),
        )
        .await;
    assert_eq!(allowed["ok"], true, "{allowed}");
    symlink(f.root.join("other"), f.root.join("output/escape")).unwrap();
    let denied = f
        .tool(
            "Write",
            json!({"path":"output/escape/forbidden.txt","content":"no"}),
            None,
        )
        .await;
    assert_eq!(denied["errorCode"], "WORKFLOW_RESOURCE_DENIED");
    assert!(!f.root.join("other/forbidden.txt").exists());
    symlink(f.root.join("future-target"), f.root.join("output/dangling")).unwrap();
    assert_eq!(
        f.tool(
            "Write",
            json!({"path":"output/dangling/future.txt","content":"no"}),
            None
        )
        .await["errorCode"],
        "WORKFLOW_RESOURCE_DENIED"
    );
    assert!(!f.root.join("future-target").exists());
}

#[tokio::test]
async fn workflow_tool_boundary_rejects_revoked_foreign_and_stale_binding_without_changing_legacy_turns(
) {
    let f = Fixture::new();
    let other = {
        let st = f.state.lock().await;
        sessions::create_session(
            &st.db,
            None,
            None,
            None,
            None,
            Some(f.root.to_string_lossy().into_owned()),
        )
        .unwrap()
        .id
    };
    let foreign = handle_request(
        f.state.clone(),
        "session.beginTurn",
        json!({"sessionId":other,"workflowRunId":"run"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(
        foreign.data.unwrap()["errorCode"],
        "WORKFLOW_RESOURCE_DENIED"
    );
    let turn = f.begin(true).await;
    {
        let st = f.state.lock().await;
        mutate(
            &st.db,
            "authorization.revoke",
            json!({"projectId":f.project,"workstreamId":"w","authorizationId":"auth"}),
        );
    }
    assert_eq!(
        f.tool(
            "Write",
            json!({"path":"output/revoked.txt","content":"no"}),
            None
        )
        .await["errorCode"],
        "WORKFLOW_RESOURCE_DENIED"
    );
    assert!(!f.root.join("output/revoked.txt").exists());
    handle_request(
        f.state.clone(),
        "session.endTurn",
        json!({"turnId":turn,"status":"completed","createNotification":false}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        f.tool(
            "Write",
            json!({"path":"output/stale.txt","content":"no"}),
            Some(&turn)
        )
        .await["errorCode"],
        "WORKFLOW_RESOURCE_DENIED"
    );
    let ordinary = f.begin(false).await;
    let legacy = f
        .tool(
            "Write",
            json!({"path":"ordinary.txt","content":"legacy unaffected"}),
            Some(&ordinary),
        )
        .await;
    assert_eq!(legacy["ok"], true, "{legacy}");
    assert_eq!(
        fs::read_to_string(f.root.join("ordinary.txt")).unwrap(),
        "legacy unaffected"
    );
}
