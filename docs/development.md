# Development Guide

## Prerequisites

### Node.js 20+

Download from [nodejs.org](https://nodejs.org/) or via a version manager:

```bash
# macOS (Homebrew)
brew install node

# or via nvm
nvm install 20 && nvm use 20
```

### Rust (stable)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

After installation, restart your shell or run `source ~/.cargo/env`. Verify with:

```bash
rustc --version
cargo --version
```

### Tauri CLI

```bash
cargo install tauri-cli --version "^2"
```

Or via npm (no Rust compilation required):

```bash
npm install -g @tauri-apps/cli
```

### System dependencies (Linux only)

```bash
sudo apt-get update && sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Setup

```bash
npm install
```

## Running

```bash
npm run tauri dev
```

## Testing

Frontend:
```bash
npm test
```

Backend:
```bash
cd src-tauri && cargo test
```

## Building

```bash
npm run tauri build
```
