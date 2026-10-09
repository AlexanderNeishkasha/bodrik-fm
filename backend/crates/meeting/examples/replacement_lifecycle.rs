//! Real isolated public WS → Rust policy → actual mediasoup allocation/recovery/leave acceptance.
//! Initial fixture tickets expire after three seconds; admitted calls must outlive them.
//! Synthetic player authority/signatures are explicit; this is not browser DTLS/RTP or device proof.
use axum::{Json, Router, routing::get};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use meeting_backend::replacement::{
    self,
    config::{Config, Settings},
};
use serde_json::{Value, json};
use sha2::Sha256;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

/// Synthetic independent fixture key; never loaded from production player configuration.
const KEY: &str = "synthetic-replacement-ticket-key-32";
/// Canonical fixture browser Origin.
const ORIGIN: &str = "http://localhost:3000";
/// Independent owner proof fixture; real browser callers must generate their own 256 random bits.
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/// Loopback WS client type used by both simulated participants.
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
/// Fallible scenario result; provider secrets are never formatted by test assertions.
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Construct a purpose-bound synthetic player ticket for the fresh discovered service incarnation.
///
/// # Errors
/// Rejects clock failures; all synthetic fixture identities are deterministic except unique ticket IDs.
fn ticket(instance: &str) -> Result<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"meeting-ticket+jwt"}"#);
    let claims = json!({"iss":"player","aud":"meeting","jti":uuid::Uuid::new_v4().to_string(),"iat":now,"nbf":now,"exp":now+3,"meetingInstanceId":instance,"conferenceId":"conference-one","generation":3,"actorId":uuid::Uuid::new_v4().to_string(),"role":"guest"});
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(KEY.as_bytes())?;
    mac.update(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

/// Open with an explicit browser origin; unauthenticated sockets allocate no native resources.
///
/// # Errors
/// Propagates loopback handshake failure.
async fn open(base: &str) -> Result<Socket> {
    let mut request = format!("{base}/ws/meeting/v1/public-room").into_client_request()?;
    request.headers_mut().insert("origin", ORIGIN.parse()?);
    Ok(connect_async(request).await?.0)
}

/// Read one bounded public JSON frame while responding to native WS heartbeats.
///
/// # Errors
/// Fails timeout, closure, socket or JSON errors; never fabricates a successful reply.
async fn receive(socket: &mut Socket) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match socket.next().await.ok_or("socket ended")?? {
                Message::Text(text) => return Ok(serde_json::from_str(&text)?),
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
                _ => return Err("unexpected public frame".into()),
            }
        }
    })
    .await?
}

/// Send one exact command frame without assuming its result will remain observable.
///
/// # Errors
/// Propagates socket serialization/delivery failure.
async fn send_command(socket: &mut Socket, stamp: &Value, id: u64, action: Value) -> Result<()> {
    socket
        .send(Message::Text(
            json!({"type":"command","version":1,"id":id,"stamp":stamp,"action":action})
                .to_string()
                .into(),
        ))
        .await?;
    Ok(())
}

/// Send one exact command and require an observed matching positive result.
///
/// # Errors
/// Unexpected schema, denial or missing native result fails the scenario.
async fn command(socket: &mut Socket, stamp: &Value, id: u64, action: Value) -> Result<Value> {
    send_command(socket, stamp, id, action).await?;
    let mut reply = receive(socket).await?;
    for _ in 0..32 {
        if reply["type"] != "event" {
            break;
        }
        if reply["stamp"] != *stamp
            || reply["revision"].as_u64().is_none()
            || reply.to_string().contains("bootId")
        {
            return Err("invalid public observation".into());
        }
        reply = receive(socket).await?;
    }
    if reply["type"] != "result" || reply["id"] != id || reply["ok"] != true {
        return Err("public command failed".into());
    }
    Ok(reply["value"].clone())
}

/// Authenticate one fixture participant through the real public ticket route.
///
/// # Errors
/// Invalid/denied welcome is a scenario failure.
async fn admit(base: &str, instance: &str) -> Result<(Socket, Value)> {
    let mut socket = open(base).await?;
    socket
        .send(Message::Text(
            json!({"type":"admit","version":1,"ticket":ticket(instance)?,"ownerProof":OWNER})
                .to_string()
                .into(),
        ))
        .await?;
    let welcome = receive(&mut socket).await?;
    if welcome["type"] != "welcome" || welcome["phase"] != "admitted" {
        return Err("admission failed".into());
    }
    Ok((socket, welcome))
}

/// Execute the actual-native two-client lifecycle without touching existing application services.
///
/// # Errors
/// Explicit native configuration, any failed allocation, recovery fence or cleanup fails the smoke.
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let player_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let player_url = format!("http://{}", player_listener.local_addr()?);
    let player = Router::new().route("/api/internal/conferences/conference-one/admission", get(|| async { Json(json!({"version":1,"conferenceId":"conference-one","generation":3,"roomSlug":"public-room","leaseSeconds":15})) }));
    let player_task = tokio::spawn(async move { axum::serve(player_listener, player).await });
    let config = configuration(&player_url)?;
    let instance = config.instance.clone();
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let base = format!("ws://{}", listener.local_addr()?);
    let mut application = replacement::Application::start(config).await?;
    let router = application.router();
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let load_commands = std::env::var("MEETING_TEST_LOAD_COMMANDS")
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()?;
    let result = scenario(&base, &instance, load_commands).await;
    let shutdown = application.shutdown().await;
    server.abort();
    let result = match result {
        Ok(Some(mut held)) => {
            match tokio::time::timeout(Duration::from_secs(3), receive(&mut held)).await {
                Ok(Err(_)) => verify_drained_room(&player_url).await,
                _ => Err("application drain retained a live socket".into()),
            }
        }
        Ok(None) if load_commands.is_some() => Ok(()),
        Ok(None) => Err("replacement smoke lost its drain verification socket".into()),
        Err(error) => Err(error),
    };
    player_task.abort();
    let _ = server.await;
    let _ = player_task.await;
    shutdown?;
    result?;
    if let Some(commands) = load_commands {
        println!("Isolated replacement completed {commands} bounded actual-native load samples");
    } else {
        println!(
            "Isolated public WS → Rust → actual native lifecycle/recovery passed (not browser DTLS/RTP)"
        );
    }
    Ok(())
}

/// Build explicitly isolated synthetic settings for a fresh application incarnation.
///
/// # Errors
/// Invalid native/player fixture settings fail rather than using legacy defaults.
fn configuration(player_url: &str) -> Result<Config> {
    Ok(Config::parse(Settings {
        bind: "127.0.0.1:0",
        media_bind: "127.0.0.1",
        media_announced: "",
        media_min: "45000",
        media_max: "45100",
        player_url,
        player_secret: "synthetic-player-secret-32characters",
        key: KEY,
        issuer: "player",
        audience: "meeting",
        origins: ORIGIN,
        invite_base: "https://example.test/api/conferences",
        bye_url: "http://localhost:3000/bye",
        buttons: "false",
        brand: "false",
        avatar_dir: "uploads/avatars",
        chat_image_dir: "uploads/chat",
        diagnostics_dir: "logs/diagnostics",
        diagnostics_retention_days: "14",
        diagnostics_file_bytes: "10485760",
        diagnostics_total_bytes: "104857600",
        ffmpeg_path: "ffmpeg",
        music_rtp_host: "127.0.0.1",
    })?)
}

/// Prove drain released the old native router: a fresh Rust owner can admit the same conference.
///
/// # Errors
/// An orphan router, rejected admission or failed explicit leave fails acceptance.
async fn verify_drained_room(player_url: &str) -> Result<()> {
    let config = configuration(player_url)?;
    let instance = config.instance.clone();
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let base = format!("ws://{}", listener.local_addr()?);
    let mut application = replacement::Application::start(config).await?;
    let router = application.router();
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let result = async {
        let (mut socket, welcome) = admit(&base, &instance).await?;
        command(&mut socket, &welcome["stamp"], 1, json!({"type":"leave"})).await?;
        Ok(())
    }
    .await;
    let shutdown = application.shutdown().await;
    server.abort();
    let _ = server.await;
    shutdown?;
    result
}

/// Allocate an Opus source/consumer, fence stolen/replayed recovery and leave through the public API.
///
/// # Errors
/// Every observation is required; no skip, fake native allocation or fallback is allowed.
async fn scenario(
    base: &str,
    instance: &str,
    load_commands: Option<usize>,
) -> Result<Option<Socket>> {
    eprintln!("replacement smoke: admission and native allocation");
    let (mut sender, welcome) = admit(base, instance).await?;
    let stamp = &welcome["stamp"];
    let caps = command(
        &mut sender,
        stamp,
        1,
        json!({"type":"media","operation":{"operation":"capabilities","payload":{}}}),
    )
    .await?;
    let transport_action =
        json!({"type":"media","operation":{"operation":"createTransport","payload":{}}});
    let transport = command(&mut sender, stamp, 2, transport_action.clone()).await?;
    let sender_transport = transport["id"].clone();
    let duplicate = command(&mut sender, stamp, 2, transport_action).await?;
    if transport != duplicate {
        return Err("duplicate allocation was not deduplicated".into());
    }
    if let Some(samples) = load_commands {
        if !(1..=12).contains(&samples) {
            return Err("load sample count must be between 1 and 12".into());
        }
        let mut latencies = Vec::with_capacity(samples);
        let total = Instant::now();
        let mut id = 3_u64;
        for _ in 0..samples {
            let started = Instant::now();
            let allocated = command(
                &mut sender,
                stamp,
                id,
                json!({"type":"media","operation":{"operation":"createTransport","payload":{}}}),
            )
            .await?;
            latencies.push(started.elapsed().as_millis());
            id += 1;
            command(
                &mut sender,
                stamp,
                id,
                json!({"type":"media","operation":{"operation":"closeTransport","payload":{"transportId":allocated["id"]}}}),
            )
            .await?;
            id += 1;
        }
        command(
            &mut sender,
            stamp,
            id,
            json!({"type":"media","operation":{"operation":"closeTransport","payload":{"transportId":sender_transport}}}),
        )
        .await?;
        id += 1;
        command(&mut sender, stamp, id, json!({"type":"leave"})).await?;
        latencies.sort_unstable();
        let percentile = |percent: usize| latencies[(latencies.len() * percent).div_ceil(100) - 1];
        let p99 = percentile(99);
        eprintln!(
            "replacement load: samples={samples} p50_ms={} p95_ms={} p99_ms={p99} total_ms={}",
            percentile(50),
            percentile(95),
            total.elapsed().as_millis()
        );
        if p99 > 2_000 || total.elapsed() > Duration::from_secs(30) {
            return Err("bounded actual-native load deadline exceeded".into());
        }
        return Ok(None);
    }
    let opus = caps["codecs"]
        .as_array()
        .and_then(|codecs| {
            codecs
                .iter()
                .find(|codec| codec["mimeType"] == "audio/opus")
        })
        .ok_or("Opus missing")?;
    let source = command(&mut sender, stamp, 3, json!({"type":"media","operation":{"operation":"produce","payload":{"transportId":transport["id"],"kind":"audio","mediaType":"audioType","rtpParameters":{"codecs":[{"mimeType":"audio/opus","payloadType":opus["preferredPayloadType"],"clockRate":48000,"channels":2}],"headerExtensions":[],"rtcp":{"cname":"fixture","reducedSize":true},"encodings":[{"ssrc":23456789}]}}}})).await?;
    let (mut receiver, receiver_welcome) = admit(base, instance).await?;
    let receiver_stamp = &receiver_welcome["stamp"];
    let transport = command(
        &mut receiver,
        receiver_stamp,
        1,
        json!({"type":"media","operation":{"operation":"createTransport","payload":{}}}),
    )
    .await?;
    let consumed = command(&mut receiver, receiver_stamp, 2, json!({"type":"media","operation":{"operation":"consume","payload":{"transportId":transport["id"],"producerId":source["producerId"],"rtpCapabilities":caps,"mediaType":"audioType"}}})).await?;
    command(&mut receiver, receiver_stamp, 3, json!({"type":"media","operation":{"operation":"resumeConsumer","payload":{"consumerId":consumed["id"]}}})).await?;
    command(&mut sender, stamp, 4, json!({"type":"media","operation":{"operation":"closeProducer","payload":{"producerId":source["producerId"]}}})).await?;
    let mut observed = Vec::new();
    for revision in 1..=2 {
        let event = receive(&mut receiver).await?;
        if event["type"] != "event"
            || event["stamp"] != *receiver_stamp
            || event["revision"] != revision
            || event.to_string().contains("bootId")
            || event.to_string().contains("conference-one")
        {
            return Err("native close observation was not safely delivered".into());
        }
        observed.push((event["kind"].clone(), event["value"]["resourceId"].clone()));
    }
    if !observed.contains(&(json!("producerClosed"), source["producerId"].clone()))
        || !observed.contains(&(json!("consumerClosed"), consumed["id"].clone()))
    {
        return Err("native producer/consumer SSE delivery missing".into());
    }
    let inventory = command(
        &mut receiver,
        receiver_stamp,
        4,
        json!({"type":"media","operation":{"operation":"inventory","payload":{}}}),
    )
    .await?;
    if inventory["consumers"] != json!([]) {
        return Err("native consumer cleanup unconfirmed".into());
    }
    eprintln!(
        "replacement smoke: direct native close delivery verified; losing an allocation response"
    );
    send_command(
        &mut sender,
        stamp,
        5,
        json!({"type":"media","operation":{"operation":"createTransport","payload":{}}}),
    )
    .await?;
    // Let the server enter the awaited native mutation, then discard its public result.
    tokio::time::sleep(Duration::from_millis(500)).await;
    sender.close(None).await?;
    // Observe that the owner is disconnected via the remaining participant, not a guessed sleep.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut id = 5;
    loop {
        let snapshot = command(
            &mut receiver,
            receiver_stamp,
            id,
            json!({"type":"snapshot"}),
        )
        .await?;
        id += 1;
        if snapshot["peers"].as_array().is_some_and(|peers| {
            peers
                .iter()
                .any(|peer| peer["stamp"] == *stamp && peer["connected"] == false)
        }) {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("disconnect not observed".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let recovery = json!({"type":"resume","version":1,"sessionId":stamp["sessionId"],"recoveryToken":welcome["recoveryToken"],"ownerProof":OWNER});
    let mut stolen = open(base).await?;
    let mut wrong = recovery.clone();
    wrong["ownerProof"] = json!("b".repeat(64));
    stolen.send(Message::Text(wrong.to_string().into())).await?;
    if receive(&mut stolen).await?["type"] != "error" {
        return Err("stolen capability granted ownership".into());
    }
    let mut resumed = open(base).await?;
    resumed
        .send(Message::Text(recovery.to_string().into()))
        .await?;
    let rotated = receive(&mut resumed).await?;
    if rotated["type"] != "welcome"
        || rotated["stamp"]["admissionEpoch"] != 2
        || rotated["recoveryToken"] == welcome["recoveryToken"]
    {
        return Err("recovery did not rotate/fence".into());
    }
    let mut replay = open(base).await?;
    replay
        .send(Message::Text(recovery.to_string().into()))
        .await?;
    if receive(&mut replay).await?["type"] != "error" {
        return Err("recovery replay accepted".into());
    }
    eprintln!("replacement smoke: recovery rotated; exercising old grace deadline");
    let mut resumed_id = 1;
    for _ in 0..11 {
        command(
            &mut resumed,
            &rotated["stamp"],
            resumed_id,
            json!({"type":"snapshot"}),
        )
        .await?;
        resumed_id += 1;
        // Pump both protocol clients so queued Ping frames receive Pong during the grace check.
        command(
            &mut receiver,
            receiver_stamp,
            id,
            json!({"type":"snapshot"}),
        )
        .await?;
        id += 1;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let retained = command(
        &mut resumed,
        &rotated["stamp"],
        resumed_id,
        json!({"type":"media","operation":{"operation":"inventory","payload":{}}}),
    )
    .await?;
    resumed_id += 1;
    if !retained["transports"]
        .as_array()
        .is_some_and(|ids| ids.len() == 2 && ids.contains(&sender_transport))
    {
        return Err("inventory did not reconcile the accepted response-lost allocation".into());
    }
    eprintln!("replacement smoke: response-lost allocation reconciled; explicit leave");
    command(&mut receiver, receiver_stamp, id, json!({"type":"leave"})).await?;
    let snapshot = command(
        &mut resumed,
        &rotated["stamp"],
        resumed_id,
        json!({"type":"snapshot"}),
    )
    .await?;
    if snapshot["peers"].as_array().map(Vec::len) != Some(1) {
        return Err("explicit leave retained ghost member".into());
    }
    // Leave a live peer/transport for the application owner to drain explicitly.
    Ok(Some(resumed))
}
