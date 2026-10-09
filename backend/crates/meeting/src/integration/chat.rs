//! Authenticated persistent-chat transport, independent of public browser credentials.
use super::PlayerClient;
use serde_json::Value;

/// Trusted room claims captured from one currently admitted meeting session.
pub struct ChatClaims<'a> {
    /// Current provider room mapping.
    pub conference: &'a str,
    /// Current revocation generation.
    pub generation: u64,
    /// Stable verified sender identity.
    pub actor: &'a str,
    /// Current runtime presenter rights.
    pub presenter: bool,
}

impl ChatClaims<'_> {
    /// Capture owned trusted claims before entering the host application boundary.
    pub fn owned(&self) -> super::services::ChatIdentity {
        super::services::ChatIdentity {
            conference: self.conference.into(),
            generation: self.generation,
            actor: self.actor.into(),
            presenter: self.presenter,
        }
    }
}

impl PlayerClient {
    /// Execute a typed chat capability directly or through the standalone HTTP adapter.
    pub async fn chat(
        &self,
        who: &ChatClaims<'_>,
        operation: super::services::ChatOperation,
    ) -> Result<Value, &'static str> {
        use super::services::ChatOperation;
        if let Some(services) = &self.services {
            return services.chat(who.owned(), operation).await;
        }
        let (suffix, method, body) = match operation {
            ChatOperation::History(before) => (
                before.map(|v| format!("?before={v}")).unwrap_or_default(),
                reqwest::Method::GET,
                None,
            ),
            ChatOperation::Append(input) => (
                String::new(),
                reqwest::Method::POST,
                Some(serde_json::to_value(input).map_err(|_| "invalid")?),
            ),
            ChatOperation::Delete(id) => (format!("/messages/{id}"), reqwest::Method::DELETE, None),
            ChatOperation::Attachment(id) => {
                (format!("/attachments/{id}"), reqwest::Method::GET, None)
            }
        };
        self.chat_request(who, &suffix, method, body).await
    }

    /// Stream attachment bytes directly to host storage or the standalone HTTP transport.
    pub async fn upload(
        &self,
        who: &ChatClaims<'_>,
        upload: super::services::Upload,
    ) -> Result<Value, &'static str> {
        if let Some(services) = &self.services {
            return services.upload(who.owned(), upload).await;
        }
        self.chat_upload(
            who,
            &upload.encoded_name,
            &upload.media_type,
            upload.size,
            reqwest::Body::wrap_stream(upload.body.into_data_stream()),
        )
        .await
    }

    /// Forward one bounded chat request with server-derived room and actor authority.
    ///
    /// # Errors
    /// Rejects transport failures, non-success statuses and oversized JSON responses.
    pub async fn chat_request(
        &self,
        who: &ChatClaims<'_>,
        suffix: &str,
        method: reqwest::Method,
        body: Option<Value>,
    ) -> Result<Value, &'static str> {
        let _permit = self
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| "capacity")?;
        let mut url = self.base.clone();
        let (path, query) = suffix
            .split_once('?')
            .map_or((suffix, None), |(path, query)| (path, Some(query)));
        url.set_path(&format!(
            "/api/internal/conferences/{}/chat{path}",
            who.conference
        ));
        url.set_query(query);
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(self.secret.as_ref())
            .header("x-chat-actor", who.actor)
            .header("x-meeting-generation", who.generation)
            .header("x-chat-presenter", who.presenter.to_string());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| "unavailable")?;
        Self::chat_json(response).await
    }

    /// Decode a bounded response without exposing private backend diagnostics.
    ///
    /// # Errors
    /// Returns stable authorization, validation, capacity or availability failures.
    pub async fn chat_json(mut response: reqwest::Response) -> Result<Value, &'static str> {
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                400 => "invalid",
                403 => "denied",
                410 => "gone",
                413 | 429 => "capacity",
                _ => "unavailable",
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "unavailable")? {
            if chunk.len() > 4_194_304usize.saturating_sub(bytes.len()) {
                return Err("capacity");
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "unavailable")
    }

    /// Stream an authenticated raw attachment to the sole persistent file writer.
    ///
    /// # Errors
    /// Returns bounded transport or backend validation failures.
    pub async fn chat_upload(
        &self,
        who: &ChatClaims<'_>,
        name: &str,
        media: &str,
        size: u64,
        body: reqwest::Body,
    ) -> Result<Value, &'static str> {
        let _permit = self
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| "capacity")?;
        let mut url = self.base.clone();
        url.set_path(&format!(
            "/api/internal/conferences/{}/chat/attachments",
            who.conference
        ));
        let response = self
            .http
            .post(url)
            .timeout(std::time::Duration::from_secs(300))
            .bearer_auth(self.secret.as_ref())
            .header("x-chat-actor", who.actor)
            .header("x-meeting-generation", who.generation)
            .header("x-file-name", name)
            .header("x-file-size", size)
            .header("content-type", media)
            .body(body)
            .send()
            .await
            .map_err(|_| "unavailable")?;
        Self::chat_json(response).await
    }
}
