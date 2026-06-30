# Laser Tango referee image — mirrors engine/mcp-image/Dockerfile, building the
# aiwars-mcp-lasertango binary and baking THIS crate's spectator SPA into /srv/view.
#
# Build context is the repo ROOT (so both protocol/ and engine/ are in scope):
#   docker build -f engine/crates/mcp-lasertango/Dockerfile -t <ecr>/<deployment>/mcp:lasertango .

# ---- planner: capture the dependency "recipe" ----
FROM rust:1.94-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /src

FROM chef AS planner
COPY protocol /src/protocol
COPY engine    /src/engine
WORKDIR /src/engine
RUN cargo chef prepare --recipe-path /recipe.json

# ---- build: compile the referee ----
FROM chef AS build
WORKDIR /src/engine
COPY --from=planner /recipe.json /recipe.json
COPY protocol/Cargo.toml /src/protocol/Cargo.toml
RUN mkdir -p /src/protocol/src && echo '// stub' > /src/protocol/src/lib.rs
RUN cargo chef cook --release --recipe-path /recipe.json -p aiwars-mcp-lasertango
COPY protocol /src/protocol
COPY engine    /src/engine
RUN find /src/protocol/src /src/engine/crates -name '*.rs' -exec touch {} +
RUN cargo build --release -p aiwars-mcp-lasertango

# ---- runtime: distroless ----
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/engine/target/release/aiwars-mcp-lasertango /usr/local/bin/aiwars-mcp-lasertango
COPY engine/crates/mcp-lasertango/view /srv/view
EXPOSE 8080 9090 8090
ENTRYPOINT ["/usr/local/bin/aiwars-mcp-lasertango"]
