# Remote Control

A Rust-based remote desktop application with screen streaming, remote input, shell access, file management, and system information via a web interface.

## Prerequisites

**Rust:** https://rustup.rs

**Linux (Fedora):**
```bash
sudo dnf install pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-kde pipewire-devel pkgconf alsa-lib-devel clang cmake nasm
```

**Windows:** Windows 10 version 1903 or later.

## Build & Run

```bash
pnpm install && pnpm build && cargo run --release
```

On first run, you'll be prompted to create admin credentials.

## Access

Local:
```
http://localhost:5000
```

From another device on the network:
```
http://<server-ip>:5000
```
