# Meeting workspace crate

`meeting-backend` is the local `backend/crates/meeting` member of the backend Cargo
workspace. It retains the included AGPL-3.0-only license and upstream attribution;
see [provenance](PROVENANCE.md). The workspace shares `backend/Cargo.lock`.

The production `backend` binary owns the HTTP listener, application authority,
SQLite persistence, meeting lifecycle and in-process mediasoup worker. The crate's
`integration::Services` ports call host authority, playback, chat and upload
operations directly. Protocol names and the stored `mirotalk` provider key remain
stable. The standalone `replacement` executable and HTTP adapter are retained for
focused tests and alternate hosts; production does not launch a separate service.

Healthy embedded music uses committed playback notifications rather than HTTP
polling. Each playing room may own one external FFmpeg process; offline conversion
uses the host's bounded preparation queue. Native media and external processes
must drain before the host supervisor starts a replacement meeting runtime.

Room authority uses sixty-second grants with a staggered 19–21 second renewal.
Commands, delivery and heartbeats check the current lease, incarnation, session and
role locally. Fresh admission/recovery still require authority. Transient failures
never extend grants; denial, expiry and replaced incarnations fail closed.

## Contracts

The implementation contracts are defined by `src/replacement/wire.rs`,
`src/signaling.rs`, the `src/runtime/` modules and `src/integration/` host ports.
The React meeting and licensed notification sounds belong to `frontend/`.
See the [root README](../../../README.md) for build/run instructions. Private
operational documentation and production configuration are not part of public
source snapshots. There is no submodule dependency.

## Checks

From the repository root, with the development backend service running:

```sh
cargo fmt --all --manifest-path backend/Cargo.toml -- --check
docker compose -f compose.dev.yml exec -T backend mbx clippy --workspace --locked --all-targets -- -D warnings
docker compose -f compose.dev.yml exec -T backend mbx test --workspace --locked
docker compose -f compose.dev.yml exec -T backend sh -c 'RUSTDOCFLAGS="-D warnings" cargo doc --workspace --locked --no-deps --document-private-items'
```

Run an individual member with `-p meeting-backend`; default workspace builds run
the backend package. The standalone entry point is `cargo run -p meeting-backend
--bin replacement`. Real browser DTLS/RTP/TURN acceptance remains separate from
unit tests and process readiness.
