//! Bounded replacement client diagnostics with strict redaction and one disk owner.
use super::{Service, session};
use crate::{media::protocol::JS_SAFE_INTEGER, signaling::SessionStamp};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

/// Maximum events accepted in one diagnostics command.
const BATCH_LIMIT: usize = 20;
/// Maximum serialized event batch accepted before enrichment.
const BATCH_BYTES: usize = 32 * 1024;
/// Maximum accepted events per connected session and fixed minute.
const EVENTS_PER_MINUTE: u16 = 60;
/// Fixed diagnostics rate window.
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Bounded pending records; diagnostics never backpressure meeting control.
const QUEUE_LIMIT: usize = 256;
/// Maximum one enriched JSONL record.
const RECORD_LIMIT: usize = 4096;

/// Validated diagnostics storage policy copied from startup configuration.
#[derive(Clone)]
pub(super) struct Policy {
    /// Dedicated JSONL directory.
    pub directory: PathBuf,
    /// Maximum age of recognized files.
    pub retention: Duration,
    /// Maximum bytes in one JSONL part.
    pub file_bytes: u64,
    /// Maximum bytes across all recognized JSONL parts.
    pub total_bytes: u64,
}

/// Cloneable non-blocking producer for the single diagnostics owner.
#[derive(Clone)]
pub(super) struct Handle {
    /// Bounded record sender.
    sender: mpsc::Sender<Record>,
}

/// Per-session accepted-event counters without user data.
pub(super) struct Limits {
    /// Fixed windows keyed by Rust-issued session identity.
    entries: Mutex<HashMap<String, Window>>,
}

/// One fixed per-session event window.
struct Window {
    /// Window start.
    started: Instant,
    /// Accepted events in the window.
    count: u16,
}

/// Strict browser event input; unknown top-level fields fail deserialization.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Event {
    /// Allowlisted operational event type.
    pub r#type: String,
    /// Optional browser wall-clock milliseconds.
    pub at: Option<f64>,
    /// Optional browser-local sequence.
    pub seq: Option<u64>,
    /// Optional primitive detail object.
    #[serde(default)]
    pub details: Map<String, Value>,
}

/// Sanitized event persisted by the replacement owner.
#[derive(Serialize)]
struct SafeEvent {
    /// Allowlisted operational event type.
    r#type: String,
    /// Bounded browser wall-clock milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_at_ms: Option<i64>,
    /// Bounded browser-local sequence.
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    /// Explicitly allowlisted primitive details.
    details: Map<String, Value>,
}

/// Server-enriched credential-free JSONL record.
#[derive(Serialize)]
struct Record {
    /// Server wall-clock milliseconds.
    server_at_ms: u64,
    /// Private conference identifier derived from the exact session.
    conference_id: String,
    /// Player-authenticated actor identity.
    actor_id: String,
    /// Rust-issued public session fence.
    stamp: SessionStamp,
    /// Sanitized browser event.
    #[serde(flatten)]
    event: SafeEvent,
}

/// Mutable state owned by one blocking file writer.
struct Writer {
    /// Validated storage policy.
    policy: Policy,
    /// Current UTC epoch day.
    day: u64,
    /// Current numbered part.
    part: u32,
    /// Current part size.
    bytes: u64,
}

impl Limits {
    /// Create empty per-session diagnostic counters.
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Consume an exact number of accepted events from one session minute.
    fn allow(&self, session_id: &str, count: u16, now: Instant) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        entries.retain(|_, window| now.duration_since(window.started) < RATE_WINDOW);
        let window = entries.entry(session_id.to_owned()).or_insert(Window {
            started: now,
            count: 0,
        });
        let Some(next) = window.count.checked_add(count) else {
            return false;
        };
        if next > EVENTS_PER_MINUTE {
            return false;
        }
        window.count = next;
        true
    }
}

impl Handle {
    /// Construct a disconnected handle for route fixtures that never submit diagnostics.
    #[cfg(test)]
    pub(super) fn disconnected() -> Self {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        Self { sender }
    }

    /// Atomically reserve queue capacity for a complete accepted batch.
    fn submit(&self, records: Vec<Record>) -> Result<(), &'static str> {
        let permits = self
            .sender
            .try_reserve_many(records.len())
            .map_err(|_| "capacity")?;
        for (permit, record) in permits.zip(records) {
            permit.send(record);
        }
        Ok(())
    }
}

/// Start one bounded diagnostics owner after validating/cleaning its directory.
///
/// # Errors
/// Storage initialization failure prevents replacement startup.
pub(super) async fn start(
    policy: Policy,
    stop: watch::Receiver<bool>,
) -> Result<(Handle, JoinHandle<()>), &'static str> {
    let writer = tokio::task::spawn_blocking(move || Writer::open(policy))
        .await
        .map_err(|_| "diagnostics unavailable")?
        .map_err(|_| "diagnostics unavailable")?;
    let (sender, receiver) = mpsc::channel(QUEUE_LIMIT);
    let task = tokio::spawn(supervise(writer, receiver, stop));
    Ok((Handle { sender }, task))
}

/// Own queued persistence and periodic retention until application shutdown.
async fn supervise(
    writer: Writer,
    mut receiver: mpsc::Receiver<Record>,
    mut stop: watch::Receiver<bool>,
) {
    let mut writer = Some(writer);
    let mut cleanup = tokio::time::interval(Duration::from_secs(60 * 60));
    loop {
        tokio::select! {
            _ = stop.changed() => {
                while let Ok(record) = receiver.try_recv() {
                    writer = persist(writer, record).await;
                }
                return;
            }
            record = receiver.recv() => {
                let Some(record) = record else { return; };
                writer = persist(writer, record).await;
            }
            _ = cleanup.tick() => {
                let Some(owner) = writer.take() else { return; };
                writer = tokio::task::spawn_blocking(move || {
                    let owner = owner;
                    if Writer::prune(&owner.policy, SystemTime::now()).is_err() {
                        tracing::error!("replacement diagnostics cleanup failed");
                    }
                    owner
                }).await.ok();
            }
        }
    }
}

/// Persist one queued record on the blocking owner and retain ownership after failures.
async fn persist(writer: Option<Writer>, record: Record) -> Option<Writer> {
    let owner = writer?;
    tokio::task::spawn_blocking(move || {
        let mut owner = owner;
        if owner.append(&record).is_err() {
            tracing::error!("replacement diagnostics persistence failed");
        }
        owner
    })
    .await
    .ok()
}

/// Sanitize, rate-limit, enrich and queue one exact-session diagnostics batch.
///
/// # Errors
/// Rejects malformed/oversized/flooded input, stale sessions and unavailable storage capacity.
pub(super) fn submit(
    service: &Service,
    stamp: &SessionStamp,
    events: Vec<Event>,
) -> Result<Value, &'static str> {
    if events.is_empty() || events.len() > BATCH_LIMIT {
        return Err("invalid");
    }
    if serde_json::to_vec(&events).map_err(|_| "invalid")?.len() > BATCH_BYTES {
        return Err("capacity");
    }
    let safe = events
        .into_iter()
        .map(sanitize)
        .collect::<Result<Vec<_>, _>>()?;
    if !service.diagnostic_limits.allow(
        &stamp.session_id,
        u16::try_from(safe.len()).map_err(|_| "capacity")?,
        Instant::now(),
    ) {
        return Err("capacity");
    }
    let (conference_id, actor_id) = session::diagnostic_context(service, stamp)?;
    let server_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "unavailable")?
        .as_millis()
        .try_into()
        .map_err(|_| "unavailable")?;
    let accepted = safe.len();
    let records = safe
        .into_iter()
        .map(|event| Record {
            server_at_ms,
            conference_id: conference_id.clone(),
            actor_id: actor_id.clone(),
            stamp: stamp.clone(),
            event,
        })
        .collect();
    service.diagnostics.submit(records)?;
    Ok(serde_json::json!({"accepted":accepted}))
}

/// Validate one event and retain only approved primitive details.
fn sanitize(event: Event) -> Result<SafeEvent, &'static str> {
    if !event_type(&event.r#type) {
        return Err("invalid");
    }
    let mut details = Map::new();
    for (key, value) in event.details {
        if !detail_key(&key) {
            continue;
        }
        let safe = match value {
            Value::String(value) => Value::String(clean(&value, 240)),
            Value::Bool(value) => Value::Bool(value),
            Value::Number(value) => {
                let number = value.as_f64().ok_or("invalid")?.clamp(-1e9, 1e9);
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or("invalid")?
            }
            _ => continue,
        };
        details.insert(key, safe);
    }
    Ok(SafeEvent {
        r#type: event.r#type,
        client_at_ms: event
            .at
            .filter(|value| value.is_finite() && value.abs() <= JS_SAFE_INTEGER as f64)
            .map(|value| value as i64),
        seq: event.seq.filter(|value| *value <= JS_SAFE_INTEGER),
        details,
    })
}

/// Conservatively redact URLs and credential/network-description shaped tokens.
fn clean(value: &str, maximum: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            if lower.contains("http://") || lower.contains("https://") {
                "[url]"
            } else if [
                "token",
                "authorization",
                "credential",
                "password",
                "candidate",
                "sdp",
            ]
            .iter()
            .any(|secret| lower.contains(secret))
            {
                "[redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(maximum)
        .collect()
}

/// Recognize the retained finite event vocabulary.
fn event_type(value: &str) -> bool {
    matches!(
        value,
        "mic_processing"
            | "browser_error"
            | "unhandled_rejection"
            | "signaling_connect"
            | "signaling_disconnect"
            | "signaling_error"
            | "signaling_reconnect_attempt"
            | "signaling_reconnect_failed"
            | "transport_state"
            | "ice_gathering_state"
            | "ice_candidate_error"
            | "transport_restart"
            | "transport_failure"
            | "recovery_start"
            | "recovery_success"
            | "recovery_failure"
    )
}

/// Recognize retained primitive detail keys.
fn detail_key(value: &str) -> bool {
    matches!(
        value,
        "transport"
            | "state"
            | "reason"
            | "message"
            | "name"
            | "code"
            | "attempt"
            | "elapsed_ms"
            | "recovered"
            | "online"
            | "visibility"
            | "phase"
            | "retry"
            | "noise_mode"
            | "echo_requested"
            | "gain_requested"
            | "noise_actual"
            | "echo_actual"
            | "gain_actual"
            | "sample_rate"
            | "channel_count"
            | "rnnoise_active"
    )
}

impl Writer {
    /// Initialize recognized storage and enforce retention/total bounds before admission.
    fn open(policy: Policy) -> Result<Self, ()> {
        fs::create_dir_all(&policy.directory).map_err(|_| ())?;
        Self::prune(&policy, SystemTime::now())?;
        let day = epoch_day(SystemTime::now())?;
        let mut part = 0;
        let bytes = loop {
            let path = policy.directory.join(file_name(day, part));
            if !path.exists() {
                break 0;
            }
            let bytes = path.metadata().map_err(|_| ())?.len();
            if bytes < policy.file_bytes {
                break bytes;
            }
            part = part.checked_add(1).ok_or(())?;
        };
        Ok(Self {
            policy,
            day,
            part,
            bytes,
        })
    }

    /// Append one bounded record, rotating before the configured part limit.
    fn append(&mut self, record: &Record) -> Result<(), ()> {
        let mut line = serde_json::to_vec(record).map_err(|_| ())?;
        line.push(b'\n');
        if line.len() > RECORD_LIMIT {
            return Err(());
        }
        let day = epoch_day(SystemTime::now())?;
        if day != self.day {
            self.day = day;
            self.part = 0;
            self.bytes = 0;
        }
        if self.bytes + line.len() as u64 > self.policy.file_bytes {
            self.part = self.part.checked_add(1).ok_or(())?;
            self.bytes = 0;
        }
        Self::make_room(&self.policy, line.len() as u64)?;
        let path = self.policy.directory.join(file_name(self.day, self.part));
        if !path.exists() {
            self.bytes = 0;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| ())?;
        file.write_all(&line)
            .and_then(|_| file.sync_data())
            .map_err(|_| ())?;
        self.bytes += line.len() as u64;
        Ok(())
    }

    /// Remove expired recognized files, then oldest files until the total budget is met.
    fn prune(policy: &Policy, now: SystemTime) -> Result<(), ()> {
        let mut files = recognized(&policy.directory)?;
        for (_, modified, path, _) in &files {
            if now
                .duration_since(*modified)
                .is_ok_and(|age| age >= policy.retention)
            {
                let _ = fs::remove_file(path);
            }
        }
        files = recognized(&policy.directory)?;
        let mut total: u64 = files.iter().map(|entry| entry.3).sum();
        for (_, _, path, bytes) in files {
            if total <= policy.total_bytes {
                break;
            }
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
        Ok(())
    }

    /// Free oldest recognized files before accepting a record beyond the total ceiling.
    fn make_room(policy: &Policy, extra: u64) -> Result<(), ()> {
        let files = recognized(&policy.directory)?;
        let mut total: u64 = files.iter().map(|entry| entry.3).sum();
        for (_, _, path, bytes) in files {
            if total.saturating_add(extra) <= policy.total_bytes {
                return Ok(());
            }
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
        if total.saturating_add(extra) <= policy.total_bytes {
            Ok(())
        } else {
            Err(())
        }
    }
}

/// List only replacement-owned diagnostics files oldest first.
fn recognized(directory: &Path) -> Result<Vec<(String, SystemTime, PathBuf, u64)>, ()> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| ())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !recognized_name(&name) {
            continue;
        }
        let metadata = entry.metadata().map_err(|_| ())?;
        if metadata.is_file() {
            files.push((
                name,
                metadata.modified().map_err(|_| ())?,
                entry.path(),
                metadata.len(),
            ));
        }
    }
    files.sort_by_key(|entry| entry.1);
    Ok(files)
}

/// Recognize only the replacement epoch-day/part JSONL namespace.
fn recognized_name(name: &str) -> bool {
    let Some(value) = name
        .strip_prefix("diagnostics-")
        .and_then(|value| value.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let Some((day, part)) = value.split_once('-') else {
        return false;
    };
    day.parse::<u64>().is_ok() && part.parse::<u32>().is_ok()
}

/// Derive a deterministic replacement-owned file name.
fn file_name(day: u64, part: u32) -> String {
    format!("diagnostics-{day}-{part}.jsonl")
}

/// Convert wall-clock time to its UTC epoch day.
fn epoch_day(now: SystemTime) -> Result<u64, ()> {
    Ok(now.duration_since(UNIX_EPOCH).map_err(|_| ())?.as_secs() / 86_400)
}

/// Sanitization, flood and storage-bound regression fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    /// Build one retained-schema diagnostic event.
    fn event(details: Value) -> Event {
        Event {
            r#type: "browser_error".into(),
            at: Some(1234.0),
            seq: Some(7),
            details: details.as_object().expect("details").clone(),
        }
    }

    /// Build one enriched record without credentials.
    fn record(index: u64) -> Record {
        Record {
            server_at_ms: index,
            conference_id: "conference".into(),
            actor_id: "actor".into(),
            stamp: SessionStamp {
                room_instance_id: "room-instance".into(),
                session_id: "session".into(),
                admission_epoch: 1,
            },
            event: sanitize(event(json!({"message":format!("failure-{index}")})))
                .expect("sanitize"),
        }
    }

    /// Unknown event types fail while fields are allowlisted, bounded and conservatively redacted.
    #[test]
    fn sanitization_cases() {
        let safe = sanitize(event(json!({
            "message":"failed https://example.test token=secret\nnext",
            "online":true,
            "candidate":"private",
            "chat":"drop",
            "elapsed_ms":2e12
        })))
        .expect("sanitize");
        assert_eq!(safe.details.get("online"), Some(&Value::Bool(true)));
        assert_eq!(safe.details.get("chat"), None);
        assert_eq!(safe.details.get("candidate"), None);
        let message = safe.details["message"].as_str().expect("message");
        assert!(!message.contains("example.test"));
        assert!(!message.contains("secret"));
        assert!(!message.contains('\n'));
        assert_eq!(safe.details["elapsed_ms"], json!(1e9));
        assert!(
            sanitize(Event {
                r#type: "chat_message".into(),
                at: None,
                seq: None,
                details: Map::new()
            })
            .is_err()
        );
    }

    /// Strict event envelopes reject unknown top-level fields and queue reservation is all-or-none.
    #[test]
    fn schema_and_queue_boundaries() {
        assert!(
            serde_json::from_value::<Event>(json!({
                "type":"transport_state","details":{"state":"connected"}
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<Event>(json!({
                "type":"transport_state","token":"secret"
            }))
            .is_err()
        );
        let (sender, mut receiver) = mpsc::channel(2);
        let handle = Handle { sender };
        assert!(
            handle
                .submit(vec![record(1), record(2), record(3)])
                .is_err()
        );
        assert!(receiver.try_recv().is_err());
    }

    /// A session accepts exactly sixty events per minute and independent sessions do not collide.
    #[test]
    fn rate_limit_boundaries() {
        let limits = Limits::new();
        let now = Instant::now();
        assert!(limits.allow("session", 20, now));
        assert!(limits.allow("session", 20, now));
        assert!(limits.allow("session", 20, now));
        assert!(!limits.allow("session", 1, now));
        assert!(limits.allow("other", 1, now));
        assert!(limits.allow("session", 1, now + RATE_WINDOW));
    }

    /// Rotation, total-budget cleanup and retention touch only recognized diagnostics files.
    #[test]
    fn storage_bounds_and_retention() {
        let directory =
            std::env::temp_dir().join(format!("replacement-diagnostics-{}", Uuid::new_v4()));
        let policy = Policy {
            directory: directory.clone(),
            retention: Duration::from_secs(60),
            file_bytes: 512,
            total_bytes: 1024,
        };
        let mut writer = Writer::open(policy.clone()).expect("writer");
        fs::write(directory.join("keep.txt"), b"keep").expect("unrelated");
        for index in 0..20 {
            writer.append(&record(index)).expect("append");
        }
        let files = recognized(&directory).expect("files");
        assert!(files.len() >= 2);
        assert!(files.iter().map(|entry| entry.3).sum::<u64>() <= policy.total_bytes);
        Writer::prune(
            &policy,
            SystemTime::now() + policy.retention + Duration::from_secs(1),
        )
        .expect("prune");
        assert!(recognized(&directory).expect("pruned").is_empty());
        assert!(directory.join("keep.txt").exists());
        fs::remove_dir_all(directory).expect("remove fixture");
    }
}
