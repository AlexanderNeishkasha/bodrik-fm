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

Requirements: Docker with Compose Watch support, OpenSSL for local certificates,
and Bun 1.4.2 if running frontend checks outside Docker. The backend image supplies
Rust 1.92, native mediasoup build tools, ffmpeg/ffprobe and yt-dlp.

Create `.env` in the repository root using independently generated random secrets
(at least 32 random characters for each signing key):

```dotenv
BODRIK_FM_JWT_SECRET=replace-with-your-own-random-secret
LOCAL_MEETING_TICKET_KEY=replace-with-a-different-random-secret
ADMIN_LOGIN=local-admin
ADMIN_PASSWORD=replace-with-your-own-password
MIROTALK_PUBLIC_URL=https://localhost:3443
CONFERENCE_UNAVAILABLE_URL=http://localhost:3000/bye
LOCAL_SFU_ANNOUNCED_IP=127.0.0.1
NEXT_PUBLIC_API_BASE=http://localhost:3001
NEXT_PUBLIC_SUPPORT_EMAIL=admin@example.invalid
```

For example, use `openssl rand -hex 32` separately for each signing key.
Never commit the resulting environment file or runtime data.
Create a **local-only** certificate (OpenSSL must support `-addext`):

```sh
mkdir -p infra/dev/certs data uploads
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout infra/dev/certs/pc.local.key \
  -out infra/dev/certs/pc.local.crt \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,DNS:pc.local,IP:127.0.0.1'
docker compose -f compose.dev.yml up --build --watch
```

Open `http://localhost:3000` and `/studio`; the admin interface is `/puppet_master`.
Meeting pages use `https://localhost:3443`. Trust the generated local certificate
in your development browser before testing microphone/camera access.
Grant conference access to a user in admin, then enable/join a meeting from Studio.
Migrations run automatically. Stop with Ctrl+C; Compose volumes preserve data.
Do not use `down -v` unless you intentionally want to delete persistent volumes.

The included Compose/proxy configuration is for local development, not a production
security configuration. For LAN use, configure matching frontend/backend origins,
invitation URLs, certificate names and an SFU address reachable by participants.
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
