# Flatpak packaging

AS Adventurer Creator ships as a **local Node server + browser UI**. The Flatpak wraps the same Linux release binary produced by `build-exe.js`.

## Prerequisites (Linux build host)

```bash
sudo apt install flatpak flatpak-builder   # or your distro equivalent
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
```

First build downloads `org.freedesktop.Platform` / `Sdk` **25.08** from Flathub
(current Flatpak first-build docs as of 2026).

Flathub remote URL (unchanged):

```bash
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
```

## Build

From the repo root:

```bash
# Full pipeline: Angular client → pkg linux-x64 → Flatpak bundle
npm run build:linux:flatpak

# Reuse an existing dist/ASAdventurer-linux-x64/ tree
node build-exe.js --target linux-flatpak --flatpak-only

# ARM64 (build host should match, or use a matching pkg binary)
npm run build:linux:flatpak:arm64
```

Outputs:

| Artifact | Path |
|----------|------|
| Bundle | `dist/ASAdventurer-linux-x64.flatpak` |
| Work dir | `dist/flatpak-work-linux-x64/` |
| Notes | `dist/ASAdventurer-linux-x64-FLATPAK.txt` |

## Install & run

```bash
flatpak install --user dist/ASAdventurer-linux-x64.flatpak
flatpak run studio.angelssword.ASAdventurer
```

The app listens on `http://localhost:3001` and opens your host browser. API keys remain in that browser’s `localStorage` for the `localhost:3001` origin.

## Files in this folder

| File | Role |
|------|------|
| `as-adventurer.sh` | Flatpak entrypoint (`command`) |
| `studio.angelssword.ASAdventurer.desktop` | App menu entry (`Terminal=true`) |
| `studio.angelssword.ASAdventurer.metainfo.xml` | AppStream metadata |
| `studio.angelssword.ASAdventurer.yml` | Manual/template manifest (relative paths) |

`build-exe.js` generates a fresh manifest with absolute paths under `dist/flatpak-work-*/` for reliable CI builds.
