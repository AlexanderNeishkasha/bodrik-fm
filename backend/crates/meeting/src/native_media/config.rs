//! Validated native media sockets, independent of signaling and player credentials.
use mediasoup::prelude::*;
use std::{net::IpAddr, ops::RangeInclusive};

/// Network configuration shared by WebRTC and the local FFmpeg RTP receiver.
#[derive(Clone)]
pub struct Network {
    /// Bindable native socket IP.
    pub ip: IpAddr,
    /// Public ICE address when the socket binds behind NAT.
    pub announced: Option<String>,
    /// Bounded nonprivileged media port allocation range.
    pub ports: RangeInclusive<u16>,
}

impl Network {
    /// Parse explicit media socket settings before starting a worker.
    ///
    /// # Errors
    /// Rejects invalid IPs, absent announced address for wildcard binds, invalid ports and hostnames.
    pub fn parse(ip: &str, announced: &str, min: &str, max: &str) -> Result<Self, String> {
        let ip: IpAddr = ip.parse().map_err(|_| "invalid media bind IP")?;
        let min: u16 = min.parse().map_err(|_| "invalid media minimum port")?;
        let max: u16 = max.parse().map_err(|_| "invalid media maximum port")?;
        if min < 1024
            || min > max
            || max - min > 1000
            || announced.len() > 253
            || !announced
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".:-".contains(&c))
            || (ip.is_unspecified() && announced.is_empty())
        {
            return Err("invalid media socket configuration".into());
        }
        Ok(Self {
            ip,
            announced: (!announced.is_empty()).then(|| announced.into()),
            ports: min..=max,
        })
    }

    /// Construct a bounded protocol-specific socket; music never announces a public address.
    pub(super) fn listen(&self, protocol: Protocol, public: bool) -> ListenInfo {
        ListenInfo {
            protocol,
            ip: self.ip,
            announced_address: public.then(|| self.announced.clone()).flatten(),
            expose_internal_ip: false,
            port: None,
            port_range: Some(self.ports.clone()),
            flags: None,
            send_buffer_size: None,
            recv_buffer_size: None,
        }
    }
}
