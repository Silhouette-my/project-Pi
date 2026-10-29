use super::*;
use crate::sessions::{self, UiMessage};
use serde_json::json;

struct Fixture {
    _dir: tempfile::TempDir,
    db: Database,
    path: String,
    session: String,
    turn: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project");
        std::fs::create_dir(&path).unwrap();
        let path = path.to_string_lossy().into_owned();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(
            &db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(path.clone()),
        )
        .unwrap()
        .id;
        let turn = sessions::begin_turn(&db, &session, None, None).unwrap();
        let message: UiMessage = serde_json::from_value(json!({"id":"source-user","role":"user","content":"Use the source adapter, not a second implementation.","createdAt":"2026-10-29T10:00:00Z"})).unwrap();
        sessions::append_message(&db, &session, &message, Some(&turn)).unwrap();
        Self {
            _dir: dir,
            db,
            path,
            session,
            turn,
        }
    }
    fn write(
        &self,
        action: &str,
        revision: i64,
        id: Option<&str>,
        content: &str,
    ) -> Result<Snapshot> {
        let project = for_session(&self.db, &self.session)?.project_id;
        let input = WriteInput {
            action: action.into(),
            expected_project_id: project,
            expected_revision: revision,
            entry_id: id.map(str::to_string),
            kind: Some("decision".into()),
            title: Some("Reuse the adapter".into()),
            content: Some(content.into()),
        };
        write_for_turn(&self.db, &self.session, Some(&self.turn), &input)
    }
}

fn another_project(f: &Fixture, name: &str) -> (String, String, String) {
    let path = f._dir.path().join(name);
    std::fs::create_dir(&path).unwrap();
    let path = path.to_string_lossy().into_owned();
    let session = sessions::create_session(
        &f.db,
        None,
        Some("agent".into()),
        None,
        None,
        Some(path.clone()),
    )
    .unwrap()
    .id;
    let turn = sessions::begin_turn(&f.db, &session, None, None).unwrap();
    let message: UiMessage = serde_json::from_value(json!({"id":format!("source-{name}"),"role":"user","content":"Shared project finding.","createdAt":"2026-10-29T10:00:00Z"})).unwrap();
    sessions::append_message(&f.db, &session, &message, Some(&turn)).unwrap();
    (path, session, turn)
}

fn remember_in(db: &Database, session: &str, turn: &str, revision: i64, content: &str) -> Snapshot {
    let input = WriteInput {
        action: "remember".into(),
        expected_project_id: for_session(db, session).unwrap().project_id,
        expected_revision: revision,
        entry_id: None,
        kind: Some("knowledge".into()),
        title: Some("Finding".into()),
        content: Some(content.into()),
    };
    write_for_turn(db, session, Some(turn), &input).unwrap()
}

#[test]
fn project_knowledge_roundtrip_correction_forget_and_reopen() {
    let f = Fixture::new();
    f.db.set_project_memory(&f.path, "User-authored instructions stay separate.")
        .unwrap();
    let first = f.write("remember", 0, None, "Reuse adapter A.").unwrap();
    assert_eq!(first.entries[0].source.message_id, "source-user");
    let next_session = sessions::create_session(
        &f.db,
        None,
        Some("agent".into()),
        None,
        None,
        Some(f.path.clone()),
    )
    .unwrap()
    .id;
    assert_eq!(for_session(&f.db, &next_session).unwrap(), first);
    assert!(f
        .write(
            "replace",
            0,
            Some(&first.entries[0].id),
            "Must not overwrite."
        )
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    let corrected = f
        .write(
            "replace",
            1,
            Some(&first.entries[0].id),
            "Use adapter B after the user correction.",
        )
        .unwrap();
    assert_eq!(corrected.entries[0].status, "superseded");
    assert_eq!(
        corrected.entries[1].supersedes_id.as_deref(),
        Some(first.entries[0].id.as_str())
    );
    let active = filtered(for_session(&f.db, &next_session).unwrap(), None, false);
    assert_eq!(active.entries.len(), 1);
    assert!(active.entries[0].content.contains("adapter B"));
    let forgotten = forget(&f.db, &first.project_id, &active.entries[0].id, 2).unwrap();
    assert_eq!(forgotten.entries[1].status, "forgotten");
    assert!(
        filtered(for_session(&f.db, &next_session).unwrap(), None, false)
            .entries
            .is_empty()
    );
    assert_eq!(
        f.db.get_project_memory(&f.path).unwrap().content,
        "User-authored instructions stay separate."
    );
    let reopened = Database::open(&f._dir.path().join("pi.sqlite")).unwrap();
    assert_eq!(get(&reopened, &first.project_id).unwrap(), forgotten);
}

#[test]
fn project_knowledge_isolates_projects_and_rejects_missing_source_or_wrong_turn() {
    let f = Fixture::new();
    let first = f.write("remember", 0, None, "Only this project.").unwrap();
    let other_path = f._dir.path().join("other");
    std::fs::create_dir(&other_path).unwrap();
    let other = sessions::create_session(
        &f.db,
        None,
        Some("agent".into()),
        None,
        None,
        Some(other_path.to_string_lossy().into_owned()),
    )
    .unwrap()
    .id;
    assert!(for_session(&f.db, &other).unwrap().entries.is_empty());
    let mut input: WriteInput = serde_json::from_value(json!({"action":"remember","expectedProjectId":first.project_id,"expectedRevision":1,"kind":"knowledge","title":"x","content":"y"})).unwrap();
    assert!(write_for_turn(&f.db, &other, Some(&f.turn), &input).is_err());
    input.expected_project_id = "another-project".into();
    assert!(write_for_turn(&f.db, &f.session, Some(&f.turn), &input)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    assert!(serde_json::from_value::<WriteInput>(json!({"action":"remember","expectedProjectId":"x","expectedRevision":0,"source":{"sessionId":other}})).is_err());
}

#[test]
fn project_knowledge_limits_are_atomic_and_delete_prevents_resurrection() {
    let f = Fixture::new();
    assert!(f.write("remember", 0, None, &"x".repeat(4097)).is_err());
    assert_eq!(for_session(&f.db, &f.session).unwrap().revision, 0);
    let first = f.write("remember", 0, None, "Durable note.").unwrap();
    f.db.delete_project_memory(&f.path).unwrap();
    assert_eq!(get(&f.db, &first.project_id).unwrap(), first);
    delete_legacy_path(&f.db, &f.path).unwrap();
    assert_eq!(get(&f.db, &first.project_id).unwrap().revision, 0);
    assert!(get(&f.db, &first.project_id).unwrap().entries.is_empty());
}

#[test]
fn project_knowledge_survives_legacy_group_upgrade_and_root_adoption() {
    let f = Fixture::new();
    let first = f.write("remember", 0, None, "Primary note.").unwrap();
    let corrected = f
        .write(
            "replace",
            1,
            Some(&first.entries[0].id),
            "Corrected primary note.",
        )
        .unwrap();
    let (other_path, other, other_turn) = another_project(&f, "other");
    let other_notes = remember_in(&f.db, &other, &other_turn, 0, "Second root note.");
    let group =
        f.db.update_project_group(
            &first.project_id,
            "Shared",
            &[f.path.clone(), other_path.clone()],
            None,
        )
        .unwrap();
    let merged = for_session(&f.db, &f.session).unwrap();
    assert_eq!(merged.project_id, group.id);
    assert_eq!(merged.entries.len(), 3);
    assert_eq!(&merged.entries[..2], corrected.entries.as_slice());
    assert_eq!(merged.entries[2], other_notes.entries[0]);
    assert_eq!(for_session(&f.db, &other).unwrap(), merged);
    assert!(f.db.kv_get(NAMESPACE, &first.project_id).unwrap().is_none());
    let (third_path, third, third_turn) = another_project(&f, "third");
    remember_in(&f.db, &third, &third_turn, 0, "Third root note.");
    f.db.update_project_group(
        &group.id,
        "Shared",
        &[f.path.clone(), other_path, third_path],
        None,
    )
    .unwrap();
    assert_eq!(for_session(&f.db, &third).unwrap().entries.len(), 4);
    f.db.delete_project_group_record(&group.id).unwrap();
    assert!(f.db.kv_get(NAMESPACE, &group.id).unwrap().is_none());
}

#[test]
fn project_knowledge_group_merge_overflow_rolls_back_identity_and_notes() {
    let f = Fixture::new();
    for revision in 0..3 {
        f.write("remember", revision, None, &"a".repeat(4000))
            .unwrap();
    }
    let original = for_session(&f.db, &f.session).unwrap();
    let (other_path, other, other_turn) = another_project(&f, "other");
    for revision in 0..3 {
        remember_in(&f.db, &other, &other_turn, revision, &"b".repeat(4000));
    }
    let other_original = for_session(&f.db, &other).unwrap();
    let error =
        f.db.create_project_group("Too large", &[f.path.clone(), other_path])
            .unwrap_err();
    assert!(error.to_string().starts_with("PROJECT_KNOWLEDGE_LIMIT:"));
    assert_eq!(for_session(&f.db, &f.session).unwrap(), original);
    assert_eq!(for_session(&f.db, &other).unwrap(), other_original);
    assert_eq!(f.db.list_project_groups().unwrap().len(), 2);
}

#[test]
fn project_knowledge_explicit_history_clear_recovers_storage_capacity() {
    let f = Fixture::new();
    f.db.set_project_memory(&f.path, "Preserve authored memory.")
        .unwrap();
    let mut snapshot = f.write("remember", 0, None, &"x".repeat(4000)).unwrap();
    loop {
        let active = snapshot
            .entries
            .iter()
            .find(|entry| entry.status == "active")
            .unwrap();
        match f.write(
            "replace",
            snapshot.revision,
            Some(&active.id),
            &"x".repeat(4000),
        ) {
            Ok(next) => snapshot = next,
            Err(error) => {
                assert!(error.to_string().contains("Clear history"));
                break;
            }
        }
        assert!(snapshot.revision < 300);
    }
    let before = for_session(&f.db, &f.session).unwrap();
    assert_eq!(before, snapshot);
    assert!(clear_history(&f.db, &before.project_id, before.revision - 1).is_err());
    let cleared = clear_history(&f.db, &before.project_id, before.revision).unwrap();
    assert_eq!(cleared.entries.len(), 1);
    assert_eq!(cleared.entries[0].status, "active");
    assert!(f
        .write(
            "replace",
            cleared.revision,
            Some(&cleared.entries[0].id),
            "Can continue recording."
        )
        .is_ok());
    assert_eq!(
        f.db.get_project_memory(&f.path).unwrap().content,
        "Preserve authored memory."
    );
}
