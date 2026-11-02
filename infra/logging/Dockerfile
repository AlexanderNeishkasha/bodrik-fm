# syntax=docker/dockerfile:1
FROM amir20/dozzle:v11.3.1 AS dozzle

FROM rust:1.92-alpine AS builder
RUN apk add --no-cache build-base
WORKDIR /app/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src src
COPY backend/crates/meeting/Cargo.toml crates/meeting/Cargo.toml
COPY backend/crates/meeting/src crates/meeting/src
COPY backend/crates/log-alerts crates/log-alerts
# Cargo discovers the complete workspace, but compiles only the alert receiver.
RUN --mount=type=cache,id=bodrik-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=bodrik-log-alerts-release,target=/app/backend/target \
    cargo build --locked --release -p log-alerts \
    && cp target/release/log-alerts /tmp/log-alerts

FROM alpine:3.23
RUN apk add --no-cache ca-certificates libgcc \
    && mkdir -p /data /etc/logging
COPY --from=dozzle /dozzle /dozzle
COPY --from=builder /tmp/log-alerts /usr/local/bin/log-alerts
COPY infra/logging/notifications.yml /etc/logging/notifications.yml
COPY infra/logging/notifications-disabled.yml /etc/logging/notifications-disabled.yml
COPY infra/logging/DOZZLE-LICENSE /usr/share/licenses/dozzle/LICENSE
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/log-alerts"]
