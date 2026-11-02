use crate::db::*;

#[derive(Clone, Copy, Debug)]
enum Line {
    Fork,
    Upstream,
    ChatPreview,
}

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

/// Build the actual historical structures, not merely a downgraded number on
/// the latest schema. Both lines started with the same v24 columns/tables.
fn fixture(path: &Path, line: Line, version: i64) {
    let db = Database::open(path).unwrap();
    db.conn().execute_batch(
        "INSERT INTO kv(ns,key,value_json,updated_at) VALUES ('fixture','saved','{\"exact\":true}',1);
         INSERT INTO providers(id,name,config_json,created_at,updated_at) VALUES ('fixture','Saved provider','{\"baseUrl\":\"https://example.test\"}',1,1);
         INSERT INTO models(provider_id,model_id,display_name,source,discovery_state,updated_at) VALUES ('fixture','discovered','Discovered','discovered','unlisted',1);
         INSERT INTO models(provider_id,model_id,display_name,source,updated_at) VALUES ('fixture','user','User model','user',1);
         INSERT INTO sessions(id,title,title_source,provider_id,model_id,prompt_preset,fast_mode,last_seq,created_at,updated_at) VALUES ('saved','Saved session','manual','fixture','user','research',1,1,1,1);
         INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES ('saved-turn','saved','completed',1,2);
         INSERT INTO messages(id,session_id,turn_id,seq,role,text,created_at) VALUES ('saved-message','saved','saved-turn',0,'user','Saved searchable text',1);",
    ).unwrap();
    let fork = matches!(line, Line::Fork);
    if !fork || version < 25 {
        db.conn()
            .execute_batch("DROP TABLE project_workflow_commands; DROP TABLE project_workflow;")
            .unwrap();
    } else {
        db.conn()
            .execute_batch(
                "INSERT INTO project_workflow VALUES(1,1,7,'{\"saved\":\"workflow\"}');
             INSERT INTO project_workflow_commands VALUES('saved-command','{}','{}',7,1);",
            )
            .unwrap();
    }
    if !fork || version < 26 {
        db.conn()
            .execute_batch(
                "DROP TABLE workflow_turn_bindings; DROP TABLE workflow_run_scopes;
            ALTER TABLE turn_queue DROP COLUMN workflow_run_id;",
            )
            .unwrap();
    } else {
        db.conn()
            .execute_batch(
                "INSERT INTO workflow_run_scopes VALUES('saved-run','{\"saved\":\"scope\"}');
             INSERT INTO workflow_turn_bindings VALUES('saved-turn','saved-run','{}');",
            )
            .unwrap();
    }
    if !matches!(line, Line::ChatPreview) && (!fork || version < 27) {
        db.conn()
            .execute_batch("ALTER TABLE sessions DROP COLUMN prompt_preset;")
            .unwrap();
    }
    if !matches!(line, Line::Upstream) || version < 25 {
        db.conn()
            .execute_batch("ALTER TABLE models DROP COLUMN discovery_state;")
            .unwrap();
    }
    if !matches!(line, Line::Upstream) || version < 27 {
        db.conn()
            .execute_batch("ALTER TABLE sessions DROP COLUMN fast_mode;")
            .unwrap();
    }
    if fork && version >= 26 {
        db.conn().execute_batch(
            "INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at,workflow_run_id)
             VALUES('saved-queue','saved','user','saved-hash','Continue saved run','ask',1,1,'saved-run');",
        ).unwrap();
    } else {
        db.conn().execute_batch(
            "INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at)
             VALUES('saved-queue','saved','user','saved-hash','Continue saved run','ask',1,1);",
        ).unwrap();
    }
    db.conn().pragma_update(None, "user_version", 24).unwrap();
    // The preserved historical steps also keep their original single-step
    // stamps. The production opener deliberately does not choose either chain.
    match line {
        Line::Fork => {
            if version >= 25 {
                super::super::project_workflow_migration::migrate_v24_to_v25(db.conn(), path)
                    .unwrap();
            }
            if version >= 26 {
                super::super::workflow_boundary_migration::migrate_v25_to_v26(db.conn(), path)
                    .unwrap();
            }
            if version >= 27 {
                super::super::migrations::migrate_v26_to_v27(db.conn(), path).unwrap();
            }
        }
        Line::Upstream => {
            if version >= 25 {
                super::super::model_discovery_migration::migrate(db.conn(), path).unwrap();
            }
            if version >= 26 {
                super::super::tool_image_storage_migration::migrate(db.conn(), path).unwrap();
            }
            if version >= 27 {
                super::super::session_fast_mode_migration::migrate_v26_to_v27(db.conn(), path)
                    .unwrap();
            }
        }
        // The parallel chat-only preview allocated v25 to the preset column
        // before Workflow was integrated. It has neither line's v25 tables.
        Line::ChatPreview => db.conn().pragma_update(None, "user_version", 25).unwrap(),
    }
    assert_eq!(self::version(db.conn()), version);
}

fn assert_merged(db: &Database, line: Line, original: i64) {
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    let preset: Option<String> = db
        .conn()
        .query_row(
            "SELECT prompt_preset FROM sessions WHERE id='saved'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        preset.as_deref(),
        (matches!(line, Line::ChatPreview) || (matches!(line, Line::Fork) && original >= 27))
            .then_some("research")
    );
    let fast: bool = db
        .conn()
        .query_row("SELECT fast_mode FROM sessions WHERE id='saved'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fast, matches!(line, Line::Upstream) && original >= 27);
    let discovered: String = db
        .conn()
        .query_row(
            "SELECT discovery_state FROM models WHERE model_id='discovered'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        discovered,
        if matches!(line, Line::Upstream) && original >= 25 {
            "unlisted"
        } else {
            "published"
        }
    );
    let user_state: Option<String> = db
        .conn()
        .query_row(
            "SELECT discovery_state FROM models WHERE model_id='user'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(user_state, None);
    assert_eq!(
        db.kv_get("fixture", "saved").unwrap(),
        Some(serde_json::json!({"exact": true}))
    );
    let saved_text: String = db
        .conn()
        .query_row(
            "SELECT text FROM messages WHERE id='saved-message'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(saved_text, "Saved searchable text");
    let queued: (String, String, Option<String>) = db
        .conn()
        .query_row(
            "SELECT content,permission_mode,workflow_run_id FROM turn_queue WHERE id='saved-queue'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(queued.0, "Continue saved run");
    assert_eq!(queued.1, "ask");
    assert_eq!(
        queued.2.as_deref(),
        (matches!(line, Line::Fork) && original >= 26).then_some("saved-run")
    );
    if matches!(line, Line::Fork) && original >= 25 {
        let snapshot: String = db
            .conn()
            .query_row(
                "SELECT snapshot_json FROM project_workflow WHERE id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(snapshot, "{\"saved\":\"workflow\"}");
        let command: String = db
            .conn()
            .query_row(
                "SELECT command_id FROM project_workflow_commands",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(command, "saved-command");
    }
    if matches!(line, Line::Fork) && original >= 26 {
        let scope: String = db
            .conn()
            .query_row(
                "SELECT dispatch_json FROM workflow_run_scopes WHERE run_id='saved-run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(scope, "{\"saved\":\"scope\"}");
        let run: String = db
            .conn()
            .query_row(
                "SELECT run_id FROM workflow_turn_bindings WHERE turn_id='saved-turn'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run, "saved-run");
    }
    // Exercise both newly merged SQL consumers after Database::open.
    let sessions = crate::sessions::list_sessions(db).unwrap();
    assert_eq!(sessions[0].id, "saved");
    assert_eq!(sessions[0].prompt_preset, preset);
    assert_eq!(sessions[0].fast_mode, fast);
    db.conn()
        .execute("INSERT INTO workflow_run_scopes VALUES('new-run','{}')", [])
        .unwrap();
    db.conn()
        .execute("DELETE FROM workflow_run_scopes WHERE run_id='new-run'", [])
        .unwrap();
}

#[test]
fn fork_and_upstream_24_through_27_converge_preserving_data_and_restart() {
    let cases = [Line::Fork, Line::Upstream]
        .into_iter()
        .flat_map(|line| (24..=27).map(move |version| (line, version)))
        .chain([(Line::ChatPreview, 25)]);
    for (line, original) in cases {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        fixture(&path, line, original);
        let transcript = dir.path().join("saved-transcript.jsonl");
        std::fs::write(&transcript, b"legacy transcript bytes\n").unwrap();
        let db = Database::open(&path).unwrap();
        assert_merged(&db, line, original);
        let backup_path = migration_backup_path(&path, original);
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(version(&backup), original);
        let integrity: String = backup
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        drop(backup);
        let backup_bytes = std::fs::read(&backup_path).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_merged(&db, line, original);
        assert_eq!(std::fs::read(backup_path).unwrap(), backup_bytes);
        assert_eq!(
            std::fs::read(transcript).unwrap(),
            b"legacy transcript bytes\n"
        );
    }
}

#[test]
fn fresh_schema_supports_both_preset_and_fast_preferences_and_future_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = crate::sessions::create_session(&db, None, None, None, None, None).unwrap();
    assert_eq!(session.prompt_preset.as_deref(), Some("none"));
    assert!(!session.fast_mode);
    let configured = crate::sessions::configure_session_with_options(
        &db,
        &session.id,
        "agent",
        None,
        None,
        None,
        None,
        Some(Some("research")),
        Some(true),
    )
    .unwrap()
    .unwrap();
    assert_eq!(configured.prompt_preset.as_deref(), Some("research"));
    assert!(configured.fast_mode);
    // Each legacy entry point must leave the other line's preference intact.
    let fast_only = crate::sessions::configure_session_with_fast_mode(
        &db,
        &session.id,
        "agent",
        None,
        None,
        None,
        None,
        Some(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(fast_only.prompt_preset.as_deref(), Some("research"));
    let preset_only = crate::sessions::configure_session_with_thinking(
        &db,
        &session.id,
        "agent",
        None,
        None,
        None,
        None,
        Some(None),
    )
    .unwrap()
    .unwrap();
    assert!(!preset_only.fast_mode);
    assert_eq!(preset_only.prompt_preset, None);
    db.conn()
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    drop(db);
    let error = Database::open(&path)
        .err()
        .expect("future schema must be refused");
    assert!(error.to_string().contains("29 is newer than supported 28"));
}

#[test]
fn convergence_failure_rolls_back_and_retains_original_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    fixture(&path, Line::Fork, 27);
    let conn = Connection::open(&path).unwrap();
    // A malformed external database makes the final model step fail after
    // earlier DDL ran; none of those earlier changes may survive the rollback.
    conn.execute_batch("ALTER TABLE models RENAME COLUMN source TO broken_source;")
        .unwrap();
    let error = super::migrate(&conn, &path, 27).unwrap_err();
    assert!(error.to_string().contains("source"), "{error:#}");
    assert_eq!(version(&conn), 27);
    let fast_columns: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('sessions') WHERE name='fast_mode'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fast_columns, 0);
    let backup = Connection::open(migration_backup_path(&path, 27)).unwrap();
    assert_eq!(version(&backup), 27);
    drop(backup);
    conn.execute_batch("ALTER TABLE models RENAME COLUMN broken_source TO source;")
        .unwrap();
    super::migrate(&conn, &path, 27).unwrap();
    assert_eq!(version(&conn), SCHEMA_VERSION);
}
