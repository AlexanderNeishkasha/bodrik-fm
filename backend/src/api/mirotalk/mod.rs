//! MiroTalk-only HTTP contract and server-side configuration.

mod client;
#[cfg(test)]
mod service_tests;

pub(crate) use client::end_conference;

/// Server-only configuration consumed exclusively by the MiroTalk adapter.
#[derive(Clone)]
pub struct Config {
    /// Public advertised HTTP(S) base used only for readable room invitations.
    pub public_url: String,
    /// Private replacement control base used only for durable retirement.
    pub replacement_url: String,
    /// Independent replacement control bearer, never exposed or logged.
    pub replacement_secret: String,
}
