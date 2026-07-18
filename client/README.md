# AS Adventurer — Angular client

Primary UI for [AS Adventurer Creator](../README.md): the 4-step VTuber pipeline (Sprite Prep → Generate Video → Video Prep → Export) plus Settings.

Generated with [Angular CLI](https://github.com/angular/angular-cli) **22**. Runtime talks to the local Express app in the repo root (`../server.js`) for AI proxies, SuperGrok OAuth, and ffmpeg export.

## Stack

| Piece | Role |
|--------|------|
| Angular 22 + TypeScript | Tabs, pipeline state, providers |
| `core/` | Settings, API client, gen-providers, xAI OAuth, toasts, cancel |
| `features/` | sprite-prep (frame editor, color picker), video-gen, video-prep, exporter, settings |
| `shared/` | Color picker, swatches, upload zone, mode selector, … |
| Root `server.js` | Proxies OpenAI / Gemini / xAI; device-code OAuth; static + export |

## Dev server

From **this** directory:

```bash
npm start
```

That runs `../scripts/dev-client.js`, which:

1. Ensures **ffmpeg** is available (transparent WebM export)  
2. Starts the **API** on port **3002** (`SKIP_BROWSER`)  
3. Starts **`ng serve`** on **3001** with `/api` → 3002 (`proxy.conf.json`)

Open **http://127.0.0.1:3001/**. The app reloads when you change sources.

UI only (API already running):

```bash
npm run start:ui
```

From the **repo root**, production-style (built UI + API on one port):

```bash
npm start    # http://localhost:3001
```

## Build

```bash
ng build
# or from repo root:
npm run build
```

Artifacts go under `dist/client/` (repo packaging copies browser output into release `www/`).

## Tests

```bash
ng test
```

## Scaffolding

```bash
ng generate component features/my-feature/my-feature
ng generate --help
```

## Related docs

- User-facing pipeline, providers, SuperGrok, packaging: **[../README.md](../README.md)**  
- Flatpak: **[../flatpak/README.md](../flatpak/README.md)**  
- Angular CLI reference: [angular.dev/tools/cli](https://angular.dev/tools/cli)
