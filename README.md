# Бодрик FM — source releases

Music broadcast and integrated video meetings for tabletop sessions.
This repository contains automated source snapshots of the application. Development
happens privately; public commits are release snapshots, not the private Git history.
`source-release.json` identifies the application version and originating commit and
records SHA-256 hashes of exported files. Production secrets and operational automation
are not included. Source files are exported without rewriting application behavior.

## License and attribution

This source release is provided under AGPL-3.0-only; see [LICENSE](LICENSE).
The integrated meeting implementation is based on
[MiroTalk SFU](https://github.com/miroslavpejic85/mirotalksfu) and has been substantially
modified for Bodrik FM, including a Rust backend and integrated frontend.
Existing notices remain applicable. Imported sounds retain their meeting license;
see `frontend/assets/meeting/README.md`. Font licenses are under
`frontend/app/fonts/licenses`. Dependencies retain their respective licenses.
The release commit date identifies the date of this modified source snapshot.

## Local build and run

Requirements: Docker Engine on Linux with Compose Watch support, a host HTTPS
reverse proxy such as Caddy, and Bun 1.4.2 for frontend checks outside Docker.
The backend image supplies Rust 1.92, native mediasoup build tools, ffmpeg/ffprobe,
yt-dlp and a pinned local mbx cache. Image builds use host networking for DNS.

Create `.env` in the repository root using independently generated secrets
(`openssl rand -hex 32` for each signing key). This example uses local hostnames;
configure DNS or hosts entries for both names to point at the development machine:

```dotenv
BODRIK_FM_JWT_SECRET=replace-with-your-own-random-secret
LOCAL_MEETING_TICKET_KEY=replace-with-a-different-random-secret
ADMIN_LOGIN=local-admin
ADMIN_PASSWORD=replace-with-your-own-password
LOCAL_DEV_HOST=bodrik.localhost
LOCAL_PROXY_PORT=8380
LOCAL_SFU_ANNOUNCED_IP=127.0.0.1
NEXT_PUBLIC_API_BASE=https://bodrik.localhost
NEXT_PUBLIC_SUPPORT_EMAIL=admin@example.invalid
CORS_ALLOW_ORIGIN=https://bodrik.localhost,https://meet.bodrik.localhost
AUTH_COOKIE_DOMAIN=bodrik.localhost
TRUST_PROXY_HEADERS=true
MEETING_PUBLIC_URL=https://meet.bodrik.localhost
CONFERENCE_UNAVAILABLE_URL=https://bodrik.localhost/meeting-unavailable
REPLACEMENT_BROWSER_ORIGINS=https://bodrik.localhost,https://meet.bodrik.localhost
REPLACEMENT_INVITE_BASE_URL=https://meet.bodrik.localhost
REPLACEMENT_BYE_URL=https://bodrik.localhost/bye
```

Never commit the resulting environment file or runtime data. The private development
launcher is not part of this source snapshot, so direct Compose users must set the
origins and URLs above explicitly. `LOCAL_DEV_HOST` configures frontend development
origins; it does not derive the backend's environment settings by itself.

Configure Caddy on the same host with this local-only site block, and trust its local
CA in the browser used for microphone/camera access:

```caddyfile
bodrik.localhost, meet.bodrik.localhost {
    tls internal
    reverse_proxy 127.0.0.1:8380
}
```

Caddy must preserve Host, send `X-Forwarded-Proto: https`, and forward WebSockets.
The included nginx proxy listens only on `127.0.0.1:8380`; frontend port 3000 is
container-internal. Port 3001 is loopback-only for backend debugging.

```sh
mkdir -p data uploads
docker compose -f compose.dev.yml config --quiet
docker compose -f compose.dev.yml up --build --watch
```

Open `https://bodrik.localhost` and `/studio`; admin is `/puppet_master`.
Meeting pages use `https://meet.bodrik.localhost`.
Grant conference access to a user in admin, then enable/join a meeting from Studio.
Migrations run automatically. Stop with Ctrl+C; Compose volumes preserve data.
Do not use `down -v` unless you intentionally want to delete persistent volumes.

The included Compose/nginx configuration is for local development behind that trusted
host proxy, not a production security configuration. The backend debugger remains on
`127.0.0.1:3001`; the frontend is internal-only, and UDP/TCP `40000-40100` must be
reachable directly by LAN participants.
Internet meetings additionally need appropriate TLS, firewall rules and usually TURN;
no production TURN credentials or server configuration are shipped here.

## Checks and static production build

```sh
bun install --cwd frontend --frozen-lockfile
bun run --cwd frontend lint
bun run --cwd frontend test
NEXT_PUBLIC_API_BASE=https://api.example.invalid bun run --cwd frontend build

docker compose -f compose.dev.yml exec -T backend mbx check --workspace --locked --all-targets
docker compose -f compose.dev.yml exec -T backend mbx test --workspace --locked
```

Production frontend output is `frontend/out`; there is no production Next.js server.
A production reverse proxy must serve static files, map `/room/<slug>` to the meeting
page and single-segment player slugs to the player page, forward `/api/*` and `/ws/*`,
serve media, and preserve the authorized internal attachment route shown in the local
proxy. `backend/dockerfile` builds the combined backend/meeting image from repository
root. `frontend/dockerfile` builds a static artifact with an explicit HTTPS API origin.
Production deployment is intentionally not automated by this repository.

Source snapshots must match the version served to users. Do not treat the latest
repository branch as proof of which version any server is running.
