# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

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
