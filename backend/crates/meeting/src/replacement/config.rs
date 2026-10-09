//! Explicit isolated service configuration, with no legacy password/key fallback.
use crate::{
    integration::PlayerClient,
    media::protocol::identifier,
    native_media::{Client, Network},
    tickets::{Redeemer, Verifier},
};
use serde_json::Value;
use std::{
    net::SocketAddr,
    path::{Component, PathBuf},
    sync::Arc,
};
use url::Url;
use uuid::Uuid;

/// Validated startup configuration; never Debug because it contains independent service keys.
pub struct Config {
    /// Validated private relay policy; never serialized or logged.
    pub(super) turn: super::turn::Policy,
    /// Public replacement listener; native media has no HTTP listener.
    pub bind: SocketAddr,
    /// Direct in-process native-resource dependency.
    pub media: Client,
    /// Independent fresh player authority client.
    pub player: PlayerClient,
    /// Private player discovery credential, never exposed to browsers.
    pub(super) player_secret: Arc<str>,
    /// Fresh CSPRNG startup incarnation; never configured/restored across restarts.
    pub instance: String,
    /// Exact ticket issuer advertised to the player over authenticated HTTP.
    pub issuer: String,
    /// Exact replacement audience advertised to the player.
    pub audience: String,
    /// One shared single-use ticket owner for all replacement sockets.
    pub redeemer: Redeemer,
    /// Explicit canonical browser origins; an empty allowlist is forbidden.
    pub origins: Vec<String>,
    /// Sanitized public HTTP configuration and redirect destinations.
    pub(super) public: PublicHttp,
    /// Sole avatar publication directory; nginx reads but never writes it.
    pub(super) avatar_dir: PathBuf,
    /// Sole temporary chat-image publication/cleanup directory.
    pub(super) chat_image_dir: PathBuf,
    /// Bounded diagnostics storage policy.
    pub(super) diagnostics: super::diagnostics::Policy,
    /// Rust-owned FFmpeg executable path.
    pub(super) ffmpeg_path: PathBuf,
    /// Fixed private host receiving music RTP inside the deployment network.
    pub(super) music_rtp_host: String,
}

/// Sanitized public HTTP settings; no service credentials or arbitrary server state.
pub(super) struct PublicHttp {
    /// Backend-owned invitation exchange prefix; the public slug is appended as one segment.
    pub invite_base: Url,
    /// Trusted same-site destination used for privacy, retired-page and 404 redirects.
    pub bye_url: Url,
    /// Browser button capability object or `false`.
    pub buttons: Value,
    /// Browser branding object or `false`.
    pub brand: Value,
}

/// Untrusted explicit startup settings, validated before any listener opens.
pub struct Settings<'a> {
    /// Independent replacement bind address.
    pub bind: &'a str,
    /// Native media socket IP.
    pub media_bind: &'a str,
    /// Public ICE hostname or IP.
    pub media_announced: &'a str,
    /// Minimum media port.
    pub media_min: &'a str,
    /// Maximum media port.
    pub media_max: &'a str,
    /// Private player base URL.
    pub player_url: &'a str,
    /// Independent player/discovery bearer.
    pub player_secret: &'a str,
    /// Replacement-only ticket key.
    pub key: &'a str,
    /// Exact player issuer identifier.
    pub issuer: &'a str,
    /// Exact replacement audience identifier.
    pub audience: &'a str,
    /// Comma-separated explicit browser origins.
    pub origins: &'a str,
    /// HTTPS backend invitation exchange prefix.
    pub invite_base: &'a str,
    /// Trusted HTTP(S) site destination for retired/public page redirects.
    pub bye_url: &'a str,
    /// Sanitized browser button capability JSON object or `false`.
    pub buttons: &'a str,
    /// Sanitized browser brand JSON object or `false`.
    pub brand: &'a str,
    /// Avatar writer directory.
    pub avatar_dir: &'a str,
    /// Temporary chat-image writer/cleanup directory.
    pub chat_image_dir: &'a str,
    /// Dedicated diagnostics JSONL directory.
    pub diagnostics_dir: &'a str,
    /// Diagnostics retention in whole days.
    pub diagnostics_retention_days: &'a str,
    /// Maximum bytes in one diagnostics JSONL part.
    pub diagnostics_file_bytes: &'a str,
    /// Maximum bytes across all diagnostics JSONL parts.
    pub diagnostics_total_bytes: &'a str,
    /// Rust-owned FFmpeg executable path.
    pub ffmpeg_path: &'a str,
    /// Fixed local RTP hostname or IP used by FFmpeg.
    pub music_rtp_host: &'a str,
}

impl Config {
    /// Load replacement-only startup settings; legacy admission configuration is neither read nor required.
    ///
    /// # Errors
    /// Rejects missing/invalid configuration; failed startup never enables permissive defaults.
    pub fn from_env() -> Result<Self, String> {
        Self::load_env(false)
    }

    /// Load browser/media settings with direct host application services.
    ///
    /// # Errors
    /// Rejects invalid public, native, storage or ticket configuration.
    pub fn embedded_from_env(
        services: Arc<dyn crate::integration::services::Services>,
    ) -> Result<Self, String> {
        let mut config = Self::load_env(true)?;
        config.player = PlayerClient::embedded(services)?;
        Ok(config)
    }

    /// Parse environment settings without requiring unused embedded HTTP credentials.
    fn load_env(embedded: bool) -> Result<Self, String> {
        let required = |name| std::env::var(name).map_err(|_| format!("{name} is required"));
        let bind = if embedded {
            "127.0.0.1:3001".into()
        } else {
            required("REPLACEMENT_BIND_ADDR")?
        };
        let player_url = if embedded {
            "http://127.0.0.1:3001".into()
        } else {
            required("MEETING_PLAYER_URL")?
        };
        let player_secret = if embedded {
            "embedded-unused-service-credential-32".into()
        } else {
            required("MEETING_PLAYER_SECRET")?
        };
        let mut config = Self::parse(Settings {
            bind: &bind,
            media_bind: &required("MEETING_RTP_BIND")?,
            media_announced: &required("MEETING_RTP_ANNOUNCED_ADDRESS")?,
            media_min: &required("MEETING_RTP_MIN")?,
            media_max: &required("MEETING_RTP_MAX")?,
            player_url: &player_url,
            player_secret: &player_secret,
            key: &required("MEETING_TICKET_KEY")?,
            issuer: &required("MEETING_TICKET_ISSUER")?,
            audience: &required("MEETING_TICKET_AUDIENCE")?,
            origins: &required("REPLACEMENT_BROWSER_ORIGINS")?,
            invite_base: &required("REPLACEMENT_INVITE_BASE_URL")?,
            bye_url: &required("REPLACEMENT_BYE_URL")?,
            buttons: &required("REPLACEMENT_UI_BUTTONS_JSON")?,
            brand: &required("REPLACEMENT_BRAND_JSON")?,
            avatar_dir: &required("REPLACEMENT_AVATAR_DIR")?,
            chat_image_dir: &required("REPLACEMENT_CHAT_IMAGE_DIR")?,
            diagnostics_dir: &required("REPLACEMENT_DIAGNOSTICS_DIR")?,
            diagnostics_retention_days: &required("REPLACEMENT_DIAGNOSTICS_RETENTION_DAYS")?,
            diagnostics_file_bytes: &required("REPLACEMENT_DIAGNOSTICS_FILE_BYTES")?,
            diagnostics_total_bytes: &required("REPLACEMENT_DIAGNOSTICS_TOTAL_BYTES")?,
            ffmpeg_path: &required("MEETING_FFMPEG_PATH")?,
            music_rtp_host: &required("MEETING_MUSIC_RTP_HOST")?,
        })?;
        config.turn = super::turn::Policy::from_env()?;
        Ok(config)
    }

    /// Validate independent dependencies and allocate a fresh random service incarnation.
    ///
    /// # Errors
    /// Rejects invalid listener/HTTP credentials, ticket scopes/key or browser origin allowlist.
    pub fn parse(settings: Settings<'_>) -> Result<Self, String> {
        let Settings {
            bind,
            media_bind,
            media_announced,
            media_min,
            media_max,
            player_url,
            player_secret,
            key,
            issuer,
            audience,
            origins,
            invite_base,
            bye_url,
            buttons,
            brand,
            avatar_dir,
            chat_image_dir,
            diagnostics_dir,
            diagnostics_retention_days,
            diagnostics_file_bytes,
            diagnostics_total_bytes,
            ffmpeg_path,
            music_rtp_host,
        } = settings;
        let bind = bind.parse().map_err(|_| "invalid replacement bind")?;
        if key == player_secret {
            return Err("replacement credentials must be independent".into());
        }
        if !identifier(issuer) || !identifier(audience) {
            return Err("invalid ticket scope".into());
        }
        let origins = origins
            .split(',')
            .map(|raw| canonical_origin(raw.trim()))
            .collect::<Result<Vec<_>, _>>()?;
        if origins.is_empty() {
            return Err("browser origins required".into());
        }
        let public = PublicHttp {
            invite_base: public_url(invite_base, true, "invalid invitation base")?,
            bye_url: public_url(bye_url, false, "invalid site redirect")?,
            buttons: public_json(buttons)?,
            brand: public_json(brand)?,
        };
        let avatar_dir = upload_path(avatar_dir)?;
        let chat_image_dir = upload_path(chat_image_dir)?;
        if avatar_dir == chat_image_dir {
            return Err("upload directories must be distinct".into());
        }
        let diagnostics_dir = upload_path(diagnostics_dir)?;
        if diagnostics_dir == avatar_dir || diagnostics_dir == chat_image_dir {
            return Err("storage directories must be distinct".into());
        }
        let retention_days = bounded_u64(
            diagnostics_retention_days,
            1,
            365,
            "invalid diagnostics retention",
        )?;
        let file_bytes = bounded_u64(
            diagnostics_file_bytes,
            4096,
            1024 * 1024 * 1024,
            "invalid diagnostics file bound",
        )?;
        let total_bytes = bounded_u64(
            diagnostics_total_bytes,
            file_bytes,
            4 * 1024 * 1024 * 1024,
            "invalid diagnostics total bound",
        )?;
        let ffmpeg_path = PathBuf::from(ffmpeg_path);
        if ffmpeg_path.as_os_str().is_empty()
            || music_rtp_host.is_empty()
            || music_rtp_host.len() > 253
            || !music_rtp_host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".:-".contains(&byte))
        {
            return Err("invalid music process configuration".into());
        }
        let diagnostics = super::diagnostics::Policy {
            directory: diagnostics_dir,
            retention: std::time::Duration::from_secs(retention_days * 24 * 60 * 60),
            file_bytes,
            total_bytes,
        };
        let media = Client::new(Network::parse(
            media_bind,
            media_announced,
            media_min,
            media_max,
        )?);
        let player = PlayerClient::new(player_url, player_secret)?;
        let instance = Uuid::new_v4().to_string();
        let verifier = Verifier::new(key.as_bytes(), issuer, audience, &instance)
            .map_err(|_| "invalid ticket configuration")?;
        let redeemer = Redeemer::new(verifier, 4096).map_err(|_| "invalid ticket capacity")?;
        Ok(Self {
            turn: super::turn::Policy::default(),
            bind,
            media,
            player,
            player_secret: Arc::from(player_secret),
            instance,
            issuer: issuer.into(),
            audience: audience.into(),
            redeemer,
            origins,
            public,
            avatar_dir,
            chat_image_dir,
            diagnostics,
            ffmpeg_path,
            music_rtp_host: music_rtp_host.into(),
        })
    }
}

/// Validate a dedicated upload directory without traversal or ambiguous empty components.
///
/// # Errors
/// Rejects empty, current-directory, parent-directory and platform-prefix components.
fn upload_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if raw.is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
    {
        return Err("invalid upload directory".into());
    }
    Ok(path)
}

/// Parse one bounded positive integer without permissive fallback.
///
/// # Errors
/// Rejects malformed and out-of-range values.
fn bounded_u64(raw: &str, minimum: u64, maximum: u64, error: &str) -> Result<u64, String> {
    let value = raw.parse::<u64>().map_err(|_| error.to_owned())?;
    if !(minimum..=maximum).contains(&value) {
        return Err(error.into());
    }
    Ok(value)
}

/// Parse a public redirect destination without credentials, query parameters or fragments.
///
/// # Errors
/// Rejects malformed destinations, non-HTTP schemes and insecure invitation exchanges.
fn public_url(raw: &str, https_only: bool, error: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| error.to_owned())?;
    if !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (https_only && url.scheme() != "https")
        || (!https_only && !matches!(url.scheme(), "http" | "https"))
    {
        return Err(error.into());
    }
    Ok(url)
}

/// Parse a bounded public JSON object or `false` while rejecting secret-shaped keys.
///
/// # Errors
/// Rejects oversized/malformed values, non-object roots and credential-like field names.
fn public_json(raw: &str) -> Result<Value, String> {
    if raw.len() > 64 * 1024 {
        return Err("public JSON too large".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "invalid public JSON")?;
    if value != Value::Bool(false) && !value.is_object() {
        return Err("public JSON must be an object or false".into());
    }
    validate_public_value(&value)?;
    Ok(value)
}

/// Recursively reject keys that could accidentally export service or admission credentials.
///
/// # Errors
/// Returns an error for any credential-shaped object key.
fn validate_public_value(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let key = key.to_ascii_lowercase();
                if ["secret", "password", "token", "credential", "authorization"]
                    .iter()
                    .any(|fragment| key.contains(fragment))
                    || key == "key"
                {
                    return Err("public JSON contains a private field".into());
                }
                validate_public_value(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_public_value(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Canonicalize a single explicit HTTP(S) origin; paths, credentials and wildcard origins are invalid.
///
/// # Errors
/// Rejects malformed/opaque/path/query/fragment/credential-bearing browser origins.
fn canonical_origin(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| "invalid browser origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("invalid browser origin".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// Configuration boundary tables do not mutate process-global environment.
#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit invalid origins never fall back to localhost or wildcard acceptance.
    #[test]
    fn origin_cases() {
        for (name, raw, accepted) in [
            ("valid", "https://example.test", true),
            ("dev", "http://localhost:3000", true),
            ("empty", "", false),
            ("wildcard", "*", false),
            ("path", "https://example.test/page", false),
            ("credential", "https://user@example.test", false),
            ("query", "https://example.test?token=x", false),
            ("opaque", "null", false),
        ] {
            assert_eq!(canonical_origin(raw).is_ok(), accepted, "{name}");
        }
    }

    /// Public configuration accepts only bounded objects/false and rejects credential-shaped keys.
    #[test]
    fn public_configuration_cases() {
        for (name, raw, accepted) in [
            ("false", "false", true),
            (
                "object",
                r#"{"chat":true,"nested":{"labels":["safe"]}}"#,
                true,
            ),
            ("array root", "[]", false),
            ("string root", r#""value""#, false),
            ("secret", r#"{"apiSecret":"private"}"#, false),
            ("password", r#"{"nested":{"password":"private"}}"#, false),
            ("token", r#"{"meetingToken":"private"}"#, false),
        ] {
            assert_eq!(public_json(raw).is_ok(), accepted, "{name}");
        }
        for (name, raw, https_only, accepted) in [
            (
                "invite https",
                "https://example.test/api/conferences",
                true,
                true,
            ),
            (
                "invite http",
                "http://example.test/api/conferences",
                true,
                false,
            ),
            ("bye http", "http://localhost:3000/bye", false, true),
            ("query", "https://example.test/path?token=x", false, false),
            ("credential", "https://user@example.test/path", false, false),
        ] {
            assert_eq!(
                public_url(raw, https_only, "invalid").is_ok(),
                accepted,
                "{name}"
            );
        }
    }

    /// Upload writer roots reject traversal, ambiguous current paths and duplicate ownership.
    #[test]
    fn upload_directory_cases() {
        for (name, raw, accepted) in [
            ("relative", "uploads/avatars", true),
            ("absolute", "/srv/uploads/avatars", true),
            ("empty", "", false),
            ("current", "./uploads", false),
            ("parent", "uploads/../private", false),
        ] {
            assert_eq!(upload_path(raw).is_ok(), accepted, "{name}");
        }
    }

    /// Diagnostics retention and byte budgets reject missing, zero and oversized values.
    #[test]
    fn diagnostics_bound_cases() {
        for (name, raw, minimum, maximum, accepted) in [
            ("minimum", "1", 1, 365, true),
            ("maximum", "365", 1, 365, true),
            ("zero", "0", 1, 365, false),
            ("oversize", "366", 1, 365, false),
            ("malformed", "daily", 1, 365, false),
        ] {
            assert_eq!(
                bounded_u64(raw, minimum, maximum, "invalid").is_ok(),
                accepted,
                "{name}"
            );
        }
    }

    /// Every independently constructed startup invalidates tickets for the preceding incarnation.
    #[test]
    fn fresh_startup_identity() {
        let create = || {
            Config::parse(Settings {
                bind: "127.0.0.1:3021",
                media_bind: "127.0.0.1",
                media_announced: "",
                media_min: "43000",
                media_max: "43100",
                player_url: "http://127.0.0.1:3001",
                player_secret: "synthetic-player-secret-32characters",
                key: "synthetic-replacement-ticket-key-32",
                issuer: "player",
                audience: "meeting",
                origins: "http://localhost:3000",
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
            })
            .expect("config")
        };
        assert_ne!(create().instance, create().instance);
    }
}
