//! Credential-free replacement tickets; no legacy proof decryption or Node application callback.
//! The isolated replacement route uses this owner after authenticated service-incarnation discovery.

#[cfg(test)]
#[path = "ticket_tests.rs"]
mod tests;

use crate::{
    integration::{Grant, PlayerClient},
    media::protocol::{JS_SAFE_INTEGER, identifier},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

/// Maximum signed ticket size, matching the public authentication-frame token budget.
pub const TOKEN_LIMIT: usize = 2048;
/// Maximum initial admission validity; this is not an admitted session lifetime.
pub const MAX_LIFETIME: u64 = 60;

/// Signed role intent from the player; native flags and browser role labels are not authoritative.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Ordinary invitation actor, never promoted by a shared service username.
    Guest,
    /// Actor authorized by the player to request presenter admission.
    Presenter,
}

/// Strict authenticated payload; no credentials, nickname or legacy host identity.
/// Deliberately lacks Debug to discourage credential/actor data in logs.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claims {
    /// Configured player issuer identifier.
    pub iss: String,
    /// Exact replacement-service audience, never the legacy SFU audience.
    pub aud: String,
    /// Globally unique player-issued ticket identity, shared across equivalent encodings.
    pub jti: String,
    /// Issued-at Unix seconds.
    pub iat: u64,
    /// Required not-before; must equal issued-at in version 1.
    pub nbf: u64,
    /// Exclusive admission expiry, at most 60 seconds after issue.
    pub exp: u64,
    /// Exact fresh Rust service incarnation, not the private Node media boot.
    pub meeting_instance_id: String,
    /// Current private player conference mapping.
    pub conference_id: String,
    /// Player-persisted revocation generation.
    pub generation: u64,
    /// Player-authenticated actor identity, not a nickname or shared mint username.
    pub actor_id: String,
    /// Verified role intent; meeting fallback/transfer remains runtime-owned.
    pub role: Role,
}

/// Fixed JWT header: no algorithm/key selection or extra header extensions.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    /// Only HS256 is supported by the private issuer contract.
    alg: String,
    /// Explicit token purpose prevents accepting ordinary auth or legacy admission JWTs.
    typ: String,
}

/// Sanitized failures; no token, key, actor, provider body or URL is formatted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// Missing/invalid independent verifier configuration.
    Configuration,
    /// Bad signature/schema/purpose/scope or invalid/expired time claims.
    Invalid,
    /// Fresh player entitlement/mapping/generation does not authorize this ticket.
    Denied,
    /// Player, clock, verifier task or replay registry is unavailable.
    Unavailable,
    /// Ticket identity was already redeemed in this service incarnation.
    Replay,
    /// Bounded crypto/HTTP/replay capacity exhausted; no accepted entry was evicted.
    Capacity,
}

/// Immutable independent signature/scope verifier; intentionally not Debug.
#[derive(Clone)]
pub struct Verifier {
    /// Independent replacement-ticket signing key, never the legacy key/password.
    key: Arc<[u8]>,
    /// Exact private player issuer.
    issuer: Arc<str>,
    /// Exact replacement audience.
    audience: Arc<str>,
    /// Fresh Rust instance identity; caller must replace it on every service start.
    instance: Arc<str>,
}

impl Verifier {
    /// Validate configuration without falling back to a legacy key or default instance.
    ///
    /// # Errors
    /// Rejects weak-sized key material or invalid scope identifiers. Caller supplies a fresh,
    /// globally unique Rust instance; reusing it after restart invalidates replay guarantees.
    pub fn new(key: &[u8], issuer: &str, audience: &str, instance: &str) -> Result<Self, Error> {
        if !(32..=256).contains(&key.len())
            || ![issuer, audience, instance].iter().all(|id| identifier(id))
        {
            return Err(Error::Configuration);
        }
        Ok(Self {
            key: Arc::from(key),
            issuer: Arc::from(issuer),
            audience: Arc::from(audience),
            instance: Arc::from(instance),
        })
    }

    /// Authenticate a bounded, strictly purpose/scope-bound ticket without consuming it.
    ///
    /// # Errors
    /// Rejects malformed/oversize signatures, unknown fields, foreign algorithms/purpose,
    /// issuer/audience/instance mismatch and invalid time/identity/generation claims.
    pub fn verify_at(&self, token: &str, now: u64) -> Result<Claims, Error> {
        if token.is_empty() || token.len() > TOKEN_LIMIT {
            return Err(Error::Invalid);
        }
        let mut parts = token.split('.');
        let header = parts.next().ok_or(Error::Invalid)?;
        let payload = parts.next().ok_or(Error::Invalid)?;
        let signature = parts.next().ok_or(Error::Invalid)?;
        if parts.next().is_some() {
            return Err(Error::Invalid);
        }
        let header_value: Header =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).map_err(|_| Error::Invalid)?)
                .map_err(|_| Error::Invalid)?;
        if header_value.alg != "HS256" || header_value.typ != "meeting-ticket+jwt" {
            return Err(Error::Invalid);
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| Error::Invalid)?;
        mac.update(header.as_bytes());
        mac.update(b".");
        mac.update(payload.as_bytes());
        mac.verify_slice(
            &URL_SAFE_NO_PAD
                .decode(signature)
                .map_err(|_| Error::Invalid)?,
        )
        .map_err(|_| Error::Invalid)?;
        let claims: Claims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| Error::Invalid)?,
        )
        .map_err(|_| Error::Invalid)?;
        if claims.iss != self.issuer.as_ref()
            || claims.aud != self.audience.as_ref()
            || claims.meeting_instance_id != self.instance.as_ref()
            || ![&claims.jti, &claims.actor_id, &claims.conference_id]
                .iter()
                .all(|id| identifier(id))
            || [claims.generation, claims.iat, claims.nbf, claims.exp]
                .iter()
                .any(|value| *value > JS_SAFE_INTEGER)
            || claims.iat > now
            || claims.nbf != claims.iat
            || claims.exp <= now
            || claims
                .exp
                .checked_sub(claims.iat)
                .is_none_or(|ttl| !(1..=MAX_LIFETIME).contains(&ttl))
        {
            return Err(Error::Invalid);
        }
        Ok(claims)
    }
}

/// One replay state shared by all clones/routes of an instance; no native membership mirror.
struct Replay {
    /// Consumed ticket identities until their signed expiry; never evict live entries for capacity.
    entries: HashMap<String, u64>,
    /// Wall-clock floor prevents backward jumps from resurrecting evicted expired entries.
    floor: u64,
}

/// Fresh authenticated decision; no native allocation or meeting admission has occurred yet.
pub struct Decision {
    /// Signed actor, role, scope and deadline authenticated by the independent verifier.
    pub claims: Claims,
    /// Fresh player lease; runtime must recheck before committing/renewing membership.
    pub grant: Grant,
}

/// Cloneable single-use redemption owner with bounded crypto/HTTP and replay state.
#[derive(Clone)]
pub struct Redeemer {
    /// Independent issuer/scope verifier.
    verifier: Verifier,
    /// Shared single-use registry, never locked across player or native awaits.
    replay: Arc<Mutex<Replay>>,
    /// Immediate admission budget, not an unbounded waiting queue.
    requests: Arc<Semaphore>,
    /// Bound consumed identities retained during the maximum initial ticket lifetime.
    capacity: usize,
}

impl Redeemer {
    /// Authenticate a reusable short-lived ticket without consuming its admission identity.
    ///
    /// # Errors
    /// Rejects invalid/expired/foreign tickets, crypto task failure or verifier capacity.
    pub async fn authenticate(&self, token: String) -> Result<Claims, Error> {
        let _permit = self
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Capacity)?;
        let verifier = self.verifier.clone();
        let now = unix_seconds()?;
        tokio::task::spawn_blocking(move || verifier.verify_at(&token, now))
            .await
            .map_err(|_| Error::Unavailable)?
    }

    /// Construct one owner per fresh Rust instance and share clones, not independent replay maps.
    ///
    /// # Errors
    /// Rejects zero/oversized replay capacity; startup must not restore an old instance ID.
    pub fn new(verifier: Verifier, capacity: usize) -> Result<Self, Error> {
        if !(1..=4096).contains(&capacity) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            verifier,
            replay: Arc::new(Mutex::new(Replay {
                entries: HashMap::new(),
                floor: 0,
            })),
            requests: Arc::new(Semaphore::new(8)),
            capacity,
        })
    }

    /// Authenticate, freshly authorize, then atomically consume one ticket before native work.
    ///
    /// # Errors
    /// Fails invalid/expired/replayed/foreign tickets, player outage/revocation or capacity.
    /// A failed post-consumption admission cannot reuse the ticket; the caller obtains a fresh one.
    pub async fn authorize(
        &self,
        player: &PlayerClient,
        room_slug: &str,
        token: String,
    ) -> Result<Decision, Error> {
        if !identifier(room_slug) {
            return Err(Error::Invalid);
        }
        let _permit = self
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Capacity)?;
        let verifier = self.verifier.clone();
        let now = unix_seconds()?;
        let claims = tokio::task::spawn_blocking(move || verifier.verify_at(&token, now))
            .await
            .map_err(|_| Error::Unavailable)??;
        let grant = player
            .authorize(&claims.conference_id)
            .await
            .map_err(|_| Error::Unavailable)?
            .ok_or(Error::Denied)?;
        if grant.generation != claims.generation || grant.room_slug != room_slug {
            return Err(Error::Denied);
        }
        self.consume(&claims, unix_seconds()?)?;
        Ok(Decision { claims, grant })
    }

    /// Atomically fence concurrent replays and expiry during authority I/O without evicting live entries.
    ///
    /// # Errors
    /// Rejects clock regression, expired/future claims, replay, poisoned registry or capacity.
    fn consume(&self, claims: &Claims, now: u64) -> Result<(), Error> {
        let mut replay = self.replay.lock().map_err(|_| Error::Unavailable)?;
        if now < replay.floor {
            return Err(Error::Unavailable);
        }
        replay.floor = now;
        if claims.exp <= now || claims.iat > now {
            return Err(Error::Invalid);
        }
        replay.entries.retain(|_, expiry| *expiry > now);
        if replay.entries.contains_key(&claims.jti) {
            return Err(Error::Replay);
        }
        if replay.entries.len() >= self.capacity {
            return Err(Error::Capacity);
        }
        replay.entries.insert(claims.jti.clone(), claims.exp);
        Ok(())
    }
}

/// Read an absolute issuance clock; failure never supplies a default-valid time.
///
/// # Errors
/// Rejects a system clock earlier than the Unix epoch.
fn unix_seconds() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| Error::Unavailable)
}
