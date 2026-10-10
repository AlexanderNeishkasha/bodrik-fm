//! Replacement admission issuance; independent keys and server-resolved actor/role authority.

use super::{db, handlers, hosts, policy};
use crate::api::{AppState, internal_error_response, json_message, normalize_origin, studio};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Optional independent replacement issuer; never contains legacy provider credentials.
#[derive(Clone)]
pub(crate) struct Issuer {
    /// Optional direct lifecycle discovery; standalone fixtures retain HTTP compatibility.
    meeting: Option<crate::meeting::Shared>,
    /// Replacement-only HMAC key, never an authentication-cookie signing key.
    key: Arc<str>,
    /// Exact configured private player issuer identifier.
    issuer: Arc<str>,
    /// Exact replacement audience identifier.
    audience: Arc<str>,
    /// Independently authenticated Rust incarnation discovery URL.
    discovery: String,
    /// Player-to-Rust discovery bearer, distinct from native-media credentials.
    secret: Arc<str>,
    /// Bounded keep-alive discovery client; redirects are prohibited.
    client: reqwest::Client,
    /// Immediate concurrency budget, with no unbounded waiters.
    requests: Arc<Semaphore>,
}

impl Issuer {
    /// Configure issuance against direct live-incarnation discovery.
    ///
    /// # Errors
    /// Rejects incomplete/invalid ticket scopes and cookie-key reuse.
    pub(crate) fn embedded_from_env(
        meeting: crate::meeting::Shared,
        cookie_key: &str,
    ) -> Result<Self, String> {
        let required = |name| std::env::var(name).map_err(|_| format!("{name} is required"));
        let key = required("MEETING_TICKET_KEY")?;
        if key == cookie_key {
            return Err("replacement ticket key must be independent".into());
        }
        let mut issuer = Self::new(
            &key,
            &required("MEETING_TICKET_ISSUER")?,
            &required("MEETING_TICKET_AUDIENCE")?,
            "http://127.0.0.1:3001",
            Arc::from("embedded-unused-service-credential-32"),
        )?;
        issuer.meeting = Some(meeting);
        Ok(issuer)
    }

    /// Validate independent settings and construct a bounded private discovery client.
    ///
    /// # Errors
    /// Rejects invalid identifiers, key material, private URL or HTTP client initialization.
    fn new(
        key: &str,
        issuer: &str,
        audience: &str,
        base: &str,
        secret: Arc<str>,
    ) -> Result<Self, String> {
        let mut url = url::Url::parse(base).map_err(|_| "invalid replacement URL")?;
        if key == secret.as_ref()
            || !(32..=256).contains(&key.len())
            || !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            || !identifier(issuer)
            || !identifier(audience)
            || url.scheme() != "http"
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("invalid replacement ticket configuration".into());
        }
        url.set_path("/internal/replacement/v1/incarnation");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|_| "replacement client initialization failed")?;
        Ok(Self {
            meeting: None,
            key: Arc::from(key),
            issuer: Arc::from(issuer),
            audience: Arc::from(audience),
            discovery: url.into(),
            secret,
            client,
            requests: Arc::new(Semaphore::new(8)),
        })
    }

    /// Discover a live Rust incarnation; never accept a browser-selected service boot.
    ///
    /// # Errors
    /// Fails closed on outage, redirects, oversized/invalid schema or foreign issuer/audience.
    async fn incarnation(&self) -> Result<String, &'static str> {
        if let Some(meeting) = &self.meeting {
            let (instance, issuer, audience) =
                meeting.incarnation().ok_or("meeting unavailable")?;
            if issuer != self.issuer.as_ref() || audience != self.audience.as_ref() {
                return Err("meeting unavailable");
            }
            return Ok(instance);
        }
        let mut response = self
            .client
            .get(&self.discovery)
            .bearer_auth(self.secret.as_ref())
            .send()
            .await
            .map_err(|_| "meeting unavailable")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("meeting unavailable");
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "meeting unavailable")? {
            if body.len() + chunk.len() > 1024 {
                return Err("meeting unavailable");
            }
            body.extend_from_slice(&chunk);
        }
        let metadata: Incarnation =
            serde_json::from_slice(&body).map_err(|_| "meeting unavailable")?;
        if metadata.version != 1
            || metadata.issuer != self.issuer.as_ref()
            || metadata.audience != self.audience.as_ref()
            || !identifier(&metadata.meeting_instance_id)
        {
            return Err("meeting unavailable");
        }
        Ok(metadata.meeting_instance_id)
    }

    /// Sign a fresh short-lived ticket after authoritative room and role resolution.
    ///
    /// # Errors
    /// Rejects missing/invalid provider bindings, clock/range failures or signing errors.
    fn sign(
        &self,
        conference: &db::Conference,
        instance: String,
        actor: String,
        presenter: bool,
        now: u64,
    ) -> Result<Ticket, &'static str> {
        let id = conference
            .provider_room_id
            .as_deref()
            .filter(|id| identifier(id))
            .ok_or("conference unavailable")?;
        let generation = u64::try_from(conference.generation)
            .ok()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("conference unavailable")?;
        let exp = now
            .checked_add(45)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("clock unavailable")?;
        if !identifier(&instance) || !identifier(&actor) {
            return Err("invalid ticket identity");
        }
        let claims = Claims {
            iss: self.issuer.as_ref(),
            aud: self.audience.as_ref(),
            jti: Uuid::new_v4().to_string(),
            iat: now,
            nbf: now,
            exp,
            meeting_instance_id: &instance,
            conference_id: id,
            generation,
            actor_id: &actor,
            role: if presenter { "presenter" } else { "guest" },
        };
        let mut header = Header::new(Algorithm::HS256);
        header.typ = Some("meeting-ticket+jwt".into());
        let ticket = jsonwebtoken::encode(
            &header,
            &claims,
            &EncodingKey::from_secret(self.key.as_bytes()),
        )
        .map_err(|_| "ticket signing unavailable")?;
        if ticket.len() > 2048 {
            return Err("ticket size exceeded");
        }
        Ok(Ticket {
            version: 1,
            ticket,
            expires_at: exp,
            room_slug: conference.room_slug.clone(),
        })
    }
}

/// Strict authenticated discovery metadata; no native boot or media secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Incarnation {
    /// Discovery protocol version.
    version: u8,
    /// Fresh Rust service startup identity.
    meeting_instance_id: String,
    /// Exact issuer expected by the verifier.
    issuer: String,
    /// Exact audience expected by the verifier.
    audience: String,
}

/// Purpose-bound payload shared with the public Rust verifier; deliberately not Debug.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claims<'a> {
    /// Exact private player issuer.
    iss: &'a str,
    /// Exact replacement service audience.
    aud: &'a str,
    /// Unique single-use ticket identity.
    jti: String,
    /// Issued-at Unix seconds.
    iat: u64,
    /// Not-before is exactly issuance.
    nbf: u64,
    /// Exclusive admission expiry.
    exp: u64,
    /// Fresh Rust incarnation obtained over authenticated private HTTP.
    meeting_instance_id: &'a str,
    /// Current private conference mapping.
    conference_id: &'a str,
    /// Persisted revocation generation.
    generation: u64,
    /// Server-resolved actor identity, never an editable nickname.
    actor_id: &'a str,
    /// Guest or live owner/admin-authorized presenter.
    role: &'a str,
}

/// Credential-bearing response: no-store and never logged or placed in a URL.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    /// Public ticket issuance contract version.
    version: u8,
    /// Opaque purpose-bound signed ticket, for the initial WS frame only.
    ticket: String,
    /// Exclusive Unix-seconds deadline for initial admission.
    expires_at: u64,
    /// Current canonical invitation slug, not a private provider mapping.
    room_slug: String,
}

/// Independently composed ticket routes; absent configuration leaves them fail-closed.
#[derive(Clone)]
struct TicketState {
    /// Existing player authority and throttle.
    app: AppState,
    /// Optional explicitly configured replacement-only issuer.
    issuer: Option<Issuer>,
}

/// Compose replacement routes without changing legacy joins or authentication cookies.
pub(crate) fn routes(app: AppState, issuer: Option<Issuer>) -> Router {
    Router::new()
        .route("/api/rooms/{slug}/conference/ticket", post(guest))
        .route("/api/studio/conference/ticket", post(presenter))
        .layer(DefaultBodyLimit::max(1024))
        .with_state(TicketState { app, issuer })
}

/// Guest request: only an optional Studio host pass; role/actor claims are forbidden.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestRequest {
    /// Single-use pass from the Studio "join" link, redeemed for this browser.
    #[serde(default)]
    host_grant: Option<String>,
}

/// Explicit empty request; browser role, actor and service incarnation claims are forbidden.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

/// Mint an invitation guest whose actor is derived from an HttpOnly device cookie (so bans
/// stick to the browser); no claimed role/actor fields accepted.
async fn guest(
    State(state): State<TicketState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(request): Json<GuestRequest>,
) -> Response {
    let device = device::from_headers(&headers);
    let guest = Guest {
        slug,
        device: &device,
        host_grant: request.host_grant,
    };
    let mut response = issue(state, headers, remote, Some(guest)).await;
    if response.status() == StatusCode::OK {
        device::append_cookie(response.headers_mut(), &device);
    }
    response
}

/// Guest ticket inputs: invitation slug, browser device and an optional host pass.
struct Guest<'a> {
    /// Public invitation slug.
    slug: String,
    /// Browser device from the cookie.
    device: &'a device::Device,
    /// Optional Studio host pass to redeem.
    host_grant: Option<String>,
}

/// Mint a presenter only after live Studio owner/admin authorization.
async fn presenter(
    State(state): State<TicketState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(_request): Json<EmptyRequest>,
) -> Response {
    issue(state, headers, remote, None).await
}

/// Check origin/throttle, discover service boot, then offload fresh DB/identity lookup and signing.
/// Guests are hosts when they redeem a Studio host pass or were remembered as hosts of
/// the room by an earlier pass from the same browser.
async fn issue(
    state: TicketState,
    headers: HeaderMap,
    remote: SocketAddr,
    guest: Option<Guest<'_>>,
) -> Response {
    let (slug, device, host_grant) = match guest {
        Some(guest) => (Some(guest.slug), Some(guest.device), guest.host_grant),
        None => (None, None, None),
    };
    if !headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_origin)
        .is_some_and(|origin| state.app.csrf_allowed_origins.contains(&origin))
    {
        return json_message(StatusCode::FORBIDDEN, "origin denied").into_response();
    }
    if !handlers::admit(&state.app, &headers, remote).await {
        return json_message(StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response();
    }
    let Some(issuer) = state.issuer else {
        return json_message(StatusCode::SERVICE_UNAVAILABLE, "replacement unavailable")
            .into_response();
    };
    let Ok(_permit) = issuer.requests.clone().try_acquire_owned() else {
        return json_message(StatusCode::SERVICE_UNAVAILABLE, "replacement busy").into_response();
    };
    // Authenticate presenters before discovery; resolve again after the await before signing.
    if slug.is_none() {
        if let Err(response) = studio::studio_user_from_http_async(&state.app, &headers).await {
            return *response;
        }
    } else if !slug.as_deref().is_some_and(identifier) {
        return json_message(StatusCode::BAD_REQUEST, "invalid room").into_response();
    }
    let guest_host = device.is_some();
    let guest_actor = device.map(|device| device::actor(&issuer.key, device));
    let instance = match issuer.incarnation().await {
        Ok(instance) => instance,
        Err(_) => {
            return json_message(StatusCode::SERVICE_UNAVAILABLE, "replacement unavailable")
                .into_response();
        }
    };
    match tokio::task::spawn_blocking(move || -> Result<Response, Box<Response>> {
        let (conference, actor, presenter) = match slug {
            Some(slug) => (
                db::by_slug(&state.app, &slug).map_err(|error| {
                    Box::new(internal_error_response("conference.ticket.lookup", error))
                })?,
                guest_actor.unwrap_or_else(|| Uuid::new_v4().to_string()),
                false,
            ),
            None => {
                let user = studio::studio_user_from_http(&state.app, &headers)?;
                (
                    db::by_room_id(&state.app, user.room_id).map_err(|error| {
                        Box::new(internal_error_response("conference.ticket.owner", error))
                    })?,
                    format!("account-{}", user.user_id),
                    true,
                )
            }
        };
        let Some(conference) = conference.filter(|conference| {
            state
                .app
                .conference_provider
                .as_deref()
                .is_some_and(|provider| policy::joinable(conference, provider.key()))
        }) else {
            return Err(Box::new(
                json_message(StatusCode::NOT_FOUND, "conference unavailable").into_response(),
            ));
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                Box::new(
                    json_message(StatusCode::SERVICE_UNAVAILABLE, "clock unavailable")
                        .into_response(),
                )
            })?
            .as_secs();
        let presenter = presenter
            || (guest_host
                && remembered_host(&state.app, &conference, &actor, host_grant.as_deref(), now)?);
        issuer
            .sign(&conference, instance, actor, presenter, now)
            .map(super::response::no_store_json)
            .map_err(|_| {
                Box::new(
                    json_message(StatusCode::SERVICE_UNAVAILABLE, "ticket unavailable")
                        .into_response(),
                )
            })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(response)) => *response,
        Err(error) => internal_error_response("conference.ticket.task", error),
    }
}

/// Redeem a host pass (if any), then report whether the guest actor is a remembered host.
///
/// # Errors
/// Database failures become an internal error response; an invalid pass is just "not host".
fn remembered_host(
    app: &AppState,
    conference: &db::Conference,
    actor: &str,
    host_grant: Option<&str>,
    now: u64,
) -> Result<bool, Box<Response>> {
    let internal = |error| Box::new(internal_error_response("conference.ticket.host", error));
    if let Some(token) = host_grant
        && hosts::redeem_grant(app, token, conference.room_id, actor, now).map_err(internal)?
    {
        return Ok(true);
    }
    hosts::is_host(app, conference.room_id, actor).map_err(internal)
}

/// Shared wire identifier boundary; accepts no path/control/whitespace characters.
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

mod device;
mod route_tests;
mod tests;
