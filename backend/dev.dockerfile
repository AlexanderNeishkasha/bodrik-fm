FROM rust:1.92-alpine

RUN rustup component add rustfmt clippy
RUN apk add --no-cache ffmpeg curl python3 py3-pip quickjs build-base linux-headers \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

RUN cargo install cargo-watch

# Pin the development cache tool and verify the architecture-specific release archive.
ARG MBX_VERSION=1.22.0
RUN case "$(uname -m)" in \
      x86_64) arch=x86_64; sha=c375135e2a3916f58da1b47537b6a954159eeacd55523d9a618b42259bd89014 ;; \
      aarch64) arch=aarch64; sha=ae4d66308c706ffbf912beb45b3166cf1cfda4d3efd23273262791235d0accf5 ;; \
      *) echo 'Unsupported mbx development architecture' >&2; exit 1 ;; \
    esac \
  && curl --fail --show-error --location "https://github.com/jdx/mr-boxington/releases/download/v${MBX_VERSION}/mbx-${arch}-unknown-linux-musl.tar.gz" -o /tmp/mbx.tar.gz \
  && printf '%s  /tmp/mbx.tar.gz\n' "$sha" | sha256sum -c - \
  && tar -xzf /tmp/mbx.tar.gz -C /usr/local/bin mbx \
  && mkdir -p /usr/local/share/mbx \
  && tar -xzf /tmp/mbx.tar.gz -C /usr/local/share/mbx LICENSE NOTICE \
  && rm /tmp/mbx.tar.gz \
  && mbx --version

# Keep mounted Cargo targets in place; all cache paths are container-local and non-remote.
ENV MBX_CACHE_DIR=/var/cache/mbx MBX_TARGET_VIEWS=0 MBX_TARGET_LANES=0 \
    MBX_DISPLAY=plain MBX_LINKER=system MBX_GC_MAX_TOTAL_SIZE=8GiB

WORKDIR /app/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/crates/meeting/Cargo.toml crates/meeting/Cargo.toml
COPY backend/crates/meeting/src crates/meeting/src

EXPOSE 3001
CMD ["cargo","watch","-w","src","-w","crates/meeting/src","-w","crates/meeting/Cargo.toml","-w","migrations","-w","Cargo.toml","-w","Cargo.lock","-i","uploads","-i","data","-s","mbx run --locked","--poll","--delay","1"]
