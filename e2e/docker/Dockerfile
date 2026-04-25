# Opt-in dockerized E2E runner.
#
# Used when a developer wants to reproduce a CI E2E failure locally
# (especially on macOS where tauri-driver is unsupported). The image
# carries everything needed to build the SSX Tauri binary AND drive
# it through tauri-driver under xvfb:
#
#   * Rust toolchain + cargo cache
#   * Node 20 + npm
#   * webkit2gtk + GTK headers (Tauri runtime)
#   * webkit2gtk-driver (the actual WebDriver tauri-driver proxies to)
#   * xvfb (virtual display so the WebView can render)
#   * tauri-driver (WebDriver shim for Tauri apps)
#
# Repo is bind-mounted at /workspace; cargo target/, npm modules,
# and ~/.cargo/registry live in named volumes so warm rebuilds stay
# fast across runs.
FROM rust:1-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        libayatana-appindicator3-dev \
        libgtk-3-dev \
        librsvg2-dev \
        libsoup-3.0-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        netcat-openbsd \
        openssh-client \
        pkg-config \
        webkit2gtk-driver \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# Node 20 from NodeSource (Debian's package is too old for Vite 8).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# tauri-driver — pinned via cargo install so we don't refetch on every
# container start. Image rebuild is the right time to upgrade it.
RUN cargo install tauri-driver --locked

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/ssx-e2e-entrypoint
RUN chmod +x /usr/local/bin/ssx-e2e-entrypoint

ENV E2E_INSIDE_DOCKER=1
ENV CARGO_TARGET_DIR=/workspace/src-tauri/target

ENTRYPOINT ["/usr/local/bin/ssx-e2e-entrypoint"]
