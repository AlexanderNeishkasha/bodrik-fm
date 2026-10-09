//! Stable per-browser guest identity for meeting bans.
//!
//! Guests get an HttpOnly device cookie on their first ticket. The ticket's actor is a
//! keyed hash of that cookie, so the same browser keeps one actor (and bans stick)
//! while the cookie value itself never reaches the meeting service or other people.

use axum::http::{HeaderMap, HeaderValue, header};
use ring::hmac;
use uuid::Uuid;

/// Browser cookie holding the opaque guest device identifier.
const DEVICE_COOKIE: &str = "bodrik_fm_meeting_device";
/// One-year device lifetime; bans themselves expire much sooner.
const DEVICE_MAX_AGE: u64 = 31_536_000;
/// Domain separation for the actor hash, so the key is never reused for another purpose.
const ACTOR_PURPOSE: &[u8] = b"meeting-guest-device-actor-v1:";

/// Guest device: the identifier and whether it must be (re)issued as a cookie.
pub(super) struct Device {
    /// Canonical hyphenated UUID from the cookie, or freshly generated.
    pub id: Uuid,
    /// True when the browser sent no valid cookie and needs `Set-Cookie`.
    pub new: bool,
}

/// Read the device cookie; a missing, malformed or duplicated value yields a new device.
pub(super) fn from_headers(headers: &HeaderMap) -> Device {
    let mut found = None;
    for cookie in headers.get_all(header::COOKIE) {
        for part in cookie.as_bytes().split(|byte| *byte == b';') {
            let part = part.trim_ascii();
            let Some(separator) = part.iter().position(|byte| *byte == b'=') else {
                continue;
            };
            if part[..separator].trim_ascii() != DEVICE_COOKIE.as_bytes() {
                continue;
            }
            if found.is_some() {
                return fresh();
            }
            found = std::str::from_utf8(&part[separator + 1..])
                .ok()
                .and_then(|value| Uuid::try_parse(value).ok());
            if found.is_none() {
                return fresh();
            }
        }
    }
    found.map_or_else(fresh, |id| Device { id, new: false })
}

/// A newly generated device that must be stored in the browser.
fn fresh() -> Device {
    Device {
        id: Uuid::new_v4(),
        new: true,
    }
}

/// Stable guest actor for one device: `guest-` plus 32 hex chars of HMAC-SHA256.
pub(super) fn actor(key: &str, device: &Device) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let mut context = hmac::Context::with_key(&key);
    context.update(ACTOR_PURPOSE);
    context.update(device.id.hyphenated().to_string().as_bytes());
    let tag = context.sign();
    let hex: String = tag.as_ref()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("guest-{hex}")
}

/// Append the device cookie when it was newly issued.
pub(super) fn append_cookie(headers: &mut HeaderMap, device: &Device) {
    if !device.new {
        return;
    }
    let value = format!(
        "{DEVICE_COOKIE}={}; Path=/api/rooms; Max-Age={DEVICE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict",
        device.id.hyphenated()
    );
    // A hyphenated UUID is always a valid header value.
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.append(header::SET_COOKIE, value);
    }
}

#[cfg(test)]
mod tests {
    //! Device cookie parsing and actor derivation tables.

    use super::*;

    /// Headers carrying the given raw `Cookie` values.
    fn cookies(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(
                header::COOKIE,
                HeaderValue::from_str(value).expect("cookie"),
            );
        }
        headers
    }

    /// A known device ID used across cases.
    const KNOWN: &str = "6f1c1f9e-2a7b-4c1d-9a3e-0b5d8c7e6f10";

    /// Cookie parsing keeps a valid device and replaces anything else.
    #[test]
    fn device_cookie_cases() {
        for (name, values, keeps) in [
            (
                "valid cookie is kept",
                vec![format!("bodrik_fm_meeting_device={KNOWN}")],
                true,
            ),
            (
                "among other cookies",
                vec![format!("a=1; bodrik_fm_meeting_device={KNOWN}; b=2")],
                true,
            ),
            ("missing cookie", vec!["a=1".to_owned()], false),
            (
                "malformed value",
                vec!["bodrik_fm_meeting_device=not-a-uuid".to_owned()],
                false,
            ),
            (
                "empty value",
                vec!["bodrik_fm_meeting_device=".to_owned()],
                false,
            ),
            (
                "duplicate cookies",
                vec![format!(
                    "bodrik_fm_meeting_device={KNOWN}; bodrik_fm_meeting_device={KNOWN}"
                )],
                false,
            ),
        ] {
            let refs: Vec<&str> = values.iter().map(String::as_str).collect();
            let device = from_headers(&cookies(&refs));
            assert_eq!(!device.new, keeps, "{name}");
            assert_eq!(device.id.to_string() == KNOWN, keeps, "{name}");
        }
    }

    /// The actor is stable per device and key, differs otherwise, and never contains the device ID.
    #[test]
    fn actor_is_keyed_and_stable() {
        let device = Device {
            id: Uuid::parse_str(KNOWN).expect("uuid"),
            new: false,
        };
        let other = Device {
            id: Uuid::new_v4(),
            new: false,
        };
        let first = actor("key-one", &device);
        assert_eq!(first, actor("key-one", &device), "stable");
        assert_ne!(first, actor("key-two", &device), "keyed");
        assert_ne!(first, actor("key-one", &other), "per device");
        assert!(first.starts_with("guest-") && first.len() == 38, "{first}");
        assert!(
            !first.contains(&KNOWN.replace('-', "")[..8]),
            "no device id"
        );
    }

    /// Only a newly issued device sets a strict HttpOnly cookie.
    #[test]
    fn cookie_is_set_only_for_new_devices() {
        for (name, new, expected) in [("new device", true, 1), ("known device", false, 0)] {
            let mut headers = HeaderMap::new();
            append_cookie(
                &mut headers,
                &Device {
                    id: Uuid::parse_str(KNOWN).expect("uuid"),
                    new,
                },
            );
            let values: Vec<_> = headers.get_all(header::SET_COOKIE).iter().collect();
            assert_eq!(values.len(), expected, "{name}");
            if let Some(value) = values.first() {
                let value = value.to_str().expect("ascii");
                assert!(
                    value.contains("HttpOnly")
                        && value.contains("Secure")
                        && value.contains("SameSite=Strict"),
                    "{name}"
                );
                assert!(
                    value.starts_with(&format!("bodrik_fm_meeting_device={KNOWN};")),
                    "{name}"
                );
            }
        }
    }
}
