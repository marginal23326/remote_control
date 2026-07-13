# Remote Control

A Rust-based remote desktop application with screen streaming, remote input, shell access, file management, and system information via a web interface.

## Prerequisites

**Rust:** https://rustup.rs

**Linux (Fedora, KDE Plasma on Wayland only):**

Install Rust via https://rustup.rs.

Install pnpm and Node:

```bash
curl -fsSL https://get.pnpm.io/install.sh | sh - && pnpm runtime install 26
```

Enable RPM Fusion:

```bash
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
```

Install the dependencies:

```bash
sudo dnf install \
  gcc clang-devel cmake nasm pkgconf \
  pipewire pipewire-devel wireplumber \
  xdg-desktop-portal xdg-desktop-portal-kde \
  openssl-devel glib2-devel \
  gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-bad-free-devel \
  gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly mesa-va-drivers-freeworld
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

## Local Network Secure Context Workaround

If you are accessing the Remote Control panel from another device on the local network using `http://<server-ip>:5000`, browser features that require a Secure Context (such as client-side audio capture and clipboard share) will be blocked by default.

### Chromium-Based Browsers (Chrome, Helium, Brave)

You can explicitly instruct your browser to treat the local server's insecure origin as secure:

1. Open your browser and navigate to:
    - **Chrome:** `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Change the dropdown menu setting for **Insecure origins treated as secure** from _Disabled_ to **Enabled**.
3. In the text box provided underneath, enter the address of your server with the protocol and port included, separated by commas if using multiple addresses:
    ```text
    http://192.168.1.100:5000,http://192.168.1.101:5000
    ```
4. Click the **Relaunch** button at the bottom of the window to apply the changes.
