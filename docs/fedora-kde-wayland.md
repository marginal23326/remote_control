# Fedora KDE Wayland Runtime Notes

Linux support is Wayland-first and uses XDG Desktop Portal with PipeWire. X11 fallback and multi-monitor selection are intentionally out of scope for this pass.

Install the Fedora runtime/build packages before building:

```bash
sudo dnf install pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-kde pipewire-devel pkgconf alsa-lib-devel clang cmake nasm
```

You can check what you need only by running:

```bash
rpm -q pipewire-devel pkgconf pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-kde
```

Run locally from the checkout:

```bash
cargo run --release
```

On first screen or input use, KDE should show the portal prompt. The app requests persistent portal permission and stores the returned restore token at:

```text
$XDG_STATE_HOME/remote-control/portal-restore-token
```

If `XDG_STATE_HOME` is not set, the fallback path is:

```text
~/.local/state/remote-control/portal-restore-token
```

The token is reused on later starts and refreshed after a successful restored session. If KDE revokes or invalidates the token, or the monitor/session layout changes, the app falls back to the normal portal prompt.

For a stable local-build identity, run the compiled binary through a persistent systemd user unit and pre-authorize that app identity in KDE's portal permission store. Fully permanent silent access is not guaranteed because portal permissions can be revoked or invalidated by the desktop environment.
