use super::*;
use crate::project_workflow;
use rusqlite::params;
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
    async fn pending_shell(
        &self,
        turn: &str,
        call: &str,
        command: &str,
    ) -> (tokio::task::JoinHandle<Value>, Value) {
        let shell = crate::tools::shell::catalog(None)
            .effective
            .expect("test shell required")
            .id;
        let params = json!({"sessionId":self.session,"turnId":turn,"toolCallId":call,
            "toolName":"Bash","args":{"command":command},"mode":"agent","permissionScope":"auto",
            "expectedCommandShellId":shell,"expectedCommandShellDialect":crate::tools::shell::dialect_for_id(&shell)});
        let state = self.state.clone();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            handle_request(state, "tools.execute", params, tx)
                .await
                .unwrap()
        });
        let notification = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let notification: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(notification["method"], "permissions.request");
        (task, notification["params"].clone())
    }
    async fn resolve(&self, request: &Value, decision: &str) {
        handle_request(
            self.state.clone(),
            "permissions.resolve",
            json!({"requestId":request["requestId"],"decision":decision}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
    }
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
async fn ordinary_shell_keeps_auto_execution_without_workflow_approval() {
    let f = Fixture::new();
    let turn = f.begin(false).await;
    let shell = crate::tools::shell::catalog(None).effective.unwrap().id;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = handle_request(f.state.clone(), "tools.execute", json!({
        "sessionId":f.session,"turnId":turn,"toolCallId":"ordinary-shell","toolName":"Bash",
        "mode":"agent","args":{"command":"printf ordinary > ordinary.txt"},
        "expectedCommandShellId":shell,"expectedCommandShellDialect":crate::tools::shell::dialect_for_id(&shell)
    }),tx).await.unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        fs::read_to_string(f.root.join("ordinary.txt")).unwrap(),
        "ordinary"
    );
    while let Ok(message) = rx.try_recv() {
        let message: Value = serde_json::from_str(&message).unwrap();
        assert_ne!(message["method"], "permissions.request");
    }
}

#[tokio::test]
async fn workflow_shell_requires_exact_once_approval_even_with_auto_and_prior_grant() {
    let f = Fixture::new();
    let turn = f.begin(true).await;
    f.state
        .lock()
        .await
        .session_grants
        .insert(f.session.clone(), vec!["Bash".into()]);
    let command = format!(
        "# {}\nprintf first >> shell-result.txt",
        "long exact approval ".repeat(150)
    );
    let (task, request) = f.pending_shell(&turn, "once-first", &command).await;
    assert_eq!(request["approvalScope"], "workflow-shell");
    assert_eq!(request["argsPreview"]["command"], command);
    assert!(!f.root.join("shell-result.txt").exists());
    let pending = f
        .state
        .lock()
        .await
        .permissions
        .pending_requests(Some(&f.session));
    assert_eq!(
        pending[0].request.approval_scope.as_deref(),
        Some("workflow-shell")
    );
    assert_eq!(pending[0].request.args_preview["command"], command);
    f.resolve(&request, "allow-once").await;
    let once_request = request.clone();
    let result = task.await.unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        fs::read_to_string(f.root.join("shell-result.txt")).unwrap(),
        "first"
    );
    assert_eq!(
        f.state.lock().await.session_grants[&f.session],
        vec!["Bash"]
    );
    let (task, request) = f
        .pending_shell(&turn, "once-second", "printf second >> shell-result.txt")
        .await;
    assert_eq!(
        fs::read_to_string(f.root.join("shell-result.txt")).unwrap(),
        "first"
    );
    f.resolve(&request, "deny").await;
    assert_eq!(task.await.unwrap()["errorCode"], "TOOL_DENIED");
    assert_eq!(
        fs::read_to_string(f.root.join("shell-result.txt")).unwrap(),
        "first"
    );
    // The resolved once request cannot be replayed to release another invocation.
    assert!(handle_request(
        f.state.clone(),
        "permissions.resolve",
        json!({"requestId":once_request["requestId"],"decision":"allow-once"}),
        mpsc::unbounded_channel().0
    )
    .await
    .is_err());
}

#[tokio::test]
async fn workflow_shell_allow_session_fails_closed_without_grant() {
    let f = Fixture::new();
    let turn = f.begin(true).await;
    let (task, request) = f
        .pending_shell(&turn, "no-session", "printf no > forbidden.txt")
        .await;
    f.resolve(&request, "allow-session").await;
    assert_eq!(task.await.unwrap()["errorCode"], "TOOL_DENIED");
    assert!(!f.root.join("forbidden.txt").exists());
    assert!(!f.state.lock().await.session_grants.contains_key(&f.session));
    let (task, request) = f
        .pending_shell(&turn, "still-prompts", "printf no > forbidden.txt")
        .await;
    f.resolve(&request, "deny").await;
    assert_eq!(task.await.unwrap()["ok"], false);
}

#[tokio::test]
async fn workflow_shell_pending_rechecks_revocation_expiry_decision_and_turn() {
    for invalidation in ["revoked", "expired", "decision", "turn", "run", "unknown"] {
        let f = Fixture::new();
        let turn = f.begin(true).await;
        let (task, request) = f
            .pending_shell(&turn, "pending-invalid", "printf no > forbidden.txt")
            .await;
        {
            let st = f.state.lock().await;
            // Mutate the authoritative persisted state to isolate the execution
            // boundary from runtime stop notification timing.
            if invalidation == "turn" {
                st.db
                    .conn()
                    .execute(
                        "UPDATE turns SET status='completed' WHERE id=?1",
                        params![turn],
                    )
                    .unwrap();
            } else {
                let mut snapshot = project_workflow::snapshot(&st.db, &json!({})).unwrap();
                match invalidation {
                    "revoked" => snapshot["authorizations"][0]["revoked"] = json!(true),
                    "expired" => {
                        snapshot["authorizations"][0]["expiresAt"] = json!("2000-01-01T00:00:00Z")
                    }
                    "decision" => snapshot["workstreams"][0]["decisionRevision"] = json!(1),
                    "run" => snapshot["runs"][0]["state"] = json!("completed"),
                    "unknown" => snapshot["runs"][0]["effects"][0]["state"] = json!("unknown"),
                    _ => unreachable!(),
                }
                st.db
                    .conn()
                    .execute(
                        "UPDATE project_workflow SET snapshot_json=?1 WHERE id=1",
                        params![snapshot.to_string()],
                    )
                    .unwrap();
            }
        }
        f.resolve(&request, "allow-once").await;
        let result = task.await.unwrap();
        assert_eq!(
            result["errorCode"], "WORKFLOW_RESOURCE_DENIED",
            "{invalidation}: {result}"
        );
        assert!(!f.root.join("forbidden.txt").exists());
    }
}

#[tokio::test]
async fn workflow_shell_cancel_pending_and_reject_detached_effects() {
    let f = Fixture::new();
    let turn = f.begin(true).await;
    let (task, _) = f
        .pending_shell(&turn, "cancel-shell", "printf no > forbidden.txt")
        .await;
    handle_request(
        f.state.clone(),
        "tools.abort",
        json!({"sessionId":f.session,"toolCallId":"cancel-shell"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let result = task.await.unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert_eq!(result["denied"], false);
    assert_eq!(result["approvalScope"], "workflow-shell");
    assert!(!f.root.join("forbidden.txt").exists());
    for field in ["runInBackground", "delegationId"] {
        let mut p = json!({"sessionId":f.session,"turnId":turn,"toolCallId":field,"toolName":"Bash","mode":"agent","args":{"command":"printf no > forbidden.txt"}});
        p[field] = if field == "runInBackground" {
            json!(true)
        } else {
            json!("delegate")
        };
        let result = handle_request(
            f.state.clone(),
            "tools.execute",
            p,
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], "WORKFLOW_RESOURCE_DENIED");
    }
}

#[tokio::test]
async fn workflow_shell_started_abort_has_no_pre_runner_approval_marker() {
    let f = Fixture::new();
    let turn = f.begin(true).await;
    let (task, request) = f
        .pending_shell(
            &turn,
            "started-abort",
            "printf started > started.txt; sleep 5; printf late > late.txt",
        )
        .await;
    f.resolve(&request, "allow-once").await;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !f.root.join("started.txt").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    handle_request(
        f.state.clone(),
        "tools.abort",
        json!({"sessionId":f.session,"toolCallId":"started-abort"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let result = task.await.unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert!(result.get("approvalScope").is_none());
    assert!(!f.root.join("late.txt").exists());
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
