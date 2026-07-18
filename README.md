# ⚔️ AS Adventurer Creator

**VTuber Creation Pipeline by Angel's Sword Studios**

_Design · Generate · Prepare · Export_

Local web app that turns a static character sprite into a transparent looping animation for streaming (OBS, PNGtuber apps, [AS Reactive Overlay](https://www.angelssword.com), etc.).

Upstream / original project: [AngelsSwordStudios/angelssword-adventurers-creator](https://github.com/AngelsSwordStudios/angelssword-adventurers-creator)

---

## What Is This?

AS Adventurer walks you through a **4-step pipeline**:

| Step | Tab                | What it does                                                            |
| ---- | ------------------ | ----------------------------------------------------------------------- |
| ①    | **Sprite Prep**    | Upload or **AI-generate** a chroma-keyed sprite; frame-edit on 1280×720 |
| ②    | **Generate Video** | Animate the sprite with online video models _(optional)_                |
| ③    | **Video Prep**     | Loop builder, trim, concat, crossfade _(offline)_                       |
| ④    | **Model Exporter** | Chroma key out → transparent WebM / GIF _(offline)_                     |

**AI providers (configure in Settings; pick per step when keys/session are ready):**

| Feature             | Providers                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Sprite generation   | **OpenAI** GPT Image 2 · **Gemini** Image · **Grok Imagine** (API key or SuperGrok OAuth) |
| Video generation    | **Gemini** Omni Flash · **Grok Imagine Video** (API key or SuperGrok OAuth)               |
| Video Prep + Export | Fully offline — no API keys                                                               |

> **No AI keys required** if you bring your own sprites and videos. Steps ③–④ work fully offline.

---

## Quick Start

### Packaged build (end users)

1. Unzip the release for your OS (Windows / macOS / Linux), or install the Flatpak on Linux.
2. Run the launcher:
   - **Windows:** `ASAdventurer.exe` or `Start AS Adventurer.bat`
   - **macOS:** first-time `First Run Setup.command`, then `Start AS Adventurer.command`
   - **Linux:** first-time `First Run Setup.sh`, then `Start AS Adventurer.sh` (or Flatpak: `flatpak run studio.angelssword.ASAdventurer`)
3. Browser opens to **http://localhost:3001** (open that URL manually if it doesn’t).

### From source (developers)

```bash
git clone https://github.com/OozeClues/angelssword-adventurers-creator.git
cd angelssword-adventurers-creator
npm install          # also installs client/ deps
npm start            # API + built UI on http://localhost:3001
```

**Angular UI development** (hot reload):

```bash
npm run dev:client   # API on 3002, ng serve on 3001 (proxies /api)
```

See [client/README.md](client/README.md) for Angular-only details.

**Optional port:**

```bash
PORT=3080 npm start
```

---

## The Pipeline

### ① Sprite Prep 🎨

Prepare a character on a solid chroma-key background for the 1280×720 pipeline canvas.

**Modes**

- **Manual Upload** — Drop PNG/JPEG/WebP. Auto key-color detection + override. Info sidebar for best source-image practices.
- **AI Generate** — Name, description, optional action, **race mode** (Normal / Kanolith / Zoalith), character + style references, provider & format options, batch count.

**Frame editor** (both modes, after you have a sprite or selected gen result)

- 1280×720 canvas with **chroma fill** in empty areas
- **Drag** to move · **corner handles** to rotate · **zoom** slider (100% = natural size)
- Spill outside the frame is **cropped** on export/handoff
- **Key color:** presets, HSV/RGB/hex picker, sample from frame, optional system eyedropper
- Custom key color is stored in your browser's `localStorage` and **persists** through Video Gen → Prep → Export

**AI providers for sprites:** GPT Image 2 (default recommendation), Gemini Image, Grok Imagine.

**Handoff:** Download framed PNG, or **Send to Generate Video**. Multi-result AI runs use **single select** before continuing.

---

### ② Generate Video 🎬 _(optional)_

Turn a still reference into a short animated clip using online models.

- Sprite from Step 1 is carried over, or upload your own reference(s)
- **Providers:** Gemini Omni Flash (recommended; image-to-video + start/end **keyframe** mode) or Grok Imagine Video (i2v / t2v, 1–15s; no dual keyframe)
- Aspect / resolution / duration depend on the selected provider
- Single-select among batch results, then **Add to Video Preparation**
- Skip entirely and drop your own MP4/WebM into Video Prep if you prefer external tools (Veo, Runway, Kling, ComfyUI, etc.)

---

### ③ Video Prep 🔄

Offline loop tooling:

- Frame scrubber, onion skin, loop point
- **Ping-Pong** / **Reverse** / no loop
- Optional second video + **crossfade**
- Handoff to Model Exporter

---

### ④ Model Exporter 📦

Chroma-key removal and transparent export:

| Mode          | Format           | Limits                        |
| ------------- | ---------------- | ----------------------------- |
| ⚔️ Adventurer | WebM (VP9 alpha) | Unlimited frames / resolution |
| 🟢 F. Normal  | GIF              | 120 frames, 1000×1000         |
| 💎 F. Premium | GIF              | 600 frames, 4000×4000         |

Controls: key color (shared pipeline color + eyedropper), similarity, smoothness, spill, scale, crop, smoke cleanup, filename presets, live preview.

---

## Settings ⚙️

| Setting                   | Purpose                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI API key**        | GPT Image 2 sprites                                                                                                                                                  |
| **Google Gemini API key** | Gemini image + Omni Flash video                                                                                                                                      |
| **Grok Imagine**          | Image + video via **API key** _or_ **SuperGrok / X Premium+ OAuth** — master toggle (`as_xai_backend` in localStorage) chooses which credential every Grok call uses |
| **Notifications**         | Sound on generation complete                                                                                                                                         |

Credentials live only in browser **localStorage** and are sent only to official OpenAI / Google / xAI (`auth.x.ai` / `api.x.ai`) endpoints through the **local** Node proxy.

---

## Changes from the original

This repository is based on [AngelsSwordStudios/angelssword-adventurers-creator](https://github.com/AngelsSwordStudios/angelssword-adventurers-creator). Relative to that upstream vanilla app, major differences include:

### Architecture

- **Angular** SPA under `client/` (primary UI) instead of a single vanilla `public/` app
- Express **`server.js`** still proxies AI + hosts static/export; production builds embed the Angular `www/` bundle
- **Legacy** vanilla sources kept under `public/` and `legacy-vanilla/` for reference (not the main UI path)

### AI / providers

- **Multi-provider image gen:** OpenAI GPT Image 2, Gemini Image, Grok Imagine (not OpenAI-only)
- **Multi-provider video gen:** Gemini Omni Flash + Grok Imagine Video (not Gemini-only)
- Per-provider **aspect / size / resolution / duration** caps in the UI
- **Grok dual backend:** xAI console API key **or** SuperGrok device-code OAuth, with a discrete **master toggle** and clear active-backend status

### Sprite Prep UX

- Interactive **frame editor**: move, rotate, zoom, chroma fill, clipped export
- **Themed color picker** (HSV plane + RGB/hex; same UI on every OS) + frame eyedropper + optional system eyedropper
- Pipeline-wide **persisted key color** (`as_key_color`)
- Info sidebars (manual best practices / AI generate guidance) instead of always-on preview-only sidebars
- Single-select among AI results before handoff

### Packaging & platforms

- Multi-target packaging via `build-exe.js`: **Windows** (x64/arm64), **macOS** (x64/arm64), **Linux** (x64/arm64), **Flatpak**
- Bundled **ffmpeg** for transparent WebM export

### Other

- Dev split: API on **3002**, Angular on **3001** with `/api` proxy (`npm run dev:client`)
- Privacy copy covers OAuth tokens as well as API keys

For packaging internals see [flatpak/README.md](flatpak/README.md). Historical design notes: [HANDOFF.md](HANDOFF.md) (may lag the Angular rewrite).

---

## Using with AS Reactive Overlay

1. Export transparent WebM with naming presets, e.g.:
   - `character_idle.webm` · `character_speaking.webm` · `character_intro.webm` · `character_outro.webm`
2. Place files in Reactive Overlay’s `public/assets/` (or your OBS/PNGtuber layout)
3. Load as animated VTuber states

WebM with alpha also works in OBS browser sources and similar tools.

---

## System Requirements

|              |                                                                  |
| ------------ | ---------------------------------------------------------------- |
| **OS**       | Windows 10/11, macOS, or Linux (x64 or arm64 depending on build) |
| **Browser**  | Chrome, Edge, or Firefox                                         |
| **Internet** | Only for AI steps (① generate / ② video). ③–④ offline            |
| **Node**     | 18+ if running from source                                       |
| **Disk**     | ~40 MB+ for the app;                                             |

---

## Project structure (source)

```
angelssword-adventurers-creator/
├── server.js                 # Express: static UI, OpenAI/Gemini/xAI proxies, OAuth, export
├── package.json              # Root scripts: start, build, multi-platform packaging
├── client/                   # Angular 22 app (primary UI)
│   ├── src/app/
│   │   ├── core/             # settings, API, providers, OAuth, pipeline state
│   │   ├── features/         # sprite-prep, video-gen, video-prep, exporter, settings
│   │   └── shared/           # color picker, swatches, upload zone, …
│   └── README.md
├── scripts/                  # ensure-ffmpeg, dev-client, build helpers
├── flatpak/                  # Flatpak packaging
├── public/ · legacy-vanilla/ # Older vanilla UI snapshots
├── bin/                      # Bundled ffmpeg (after ensure-ffmpeg / package)
└── dist/                     # Release outputs
```

---

## Tips

- **Magenta** (`#FF00FF`) is often safest for character art chroma key.
- **Ping-Pong** loops are the easiest seamless idles.
- Default video prompt is tuned for **Gemini**; replace `(Character description)` and `(Animation Type)` with short, specific phrases.
- **GPT Image 2** is preferred for sprites especially when using race modes (coherent placement + prompts).
- Grok login issues: Settings → Logout / Refresh Token / re-login with SuperGrok.

---

## Troubleshooting

| Problem               | Solution                                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| Browser doesn’t open  | Open http://localhost:3001 manually                                        |
| Port 3001 in use      | Set `PORT` or close other instances                                        |
| `npm start` fails     | Node 18+; run `npm install` (and under `client/`)                          |
| OpenAI / Gemini fails | Settings → key + Test; check credits                                       |
| Grok not available    | Settings → API key **or** SuperGrok login; check **active backend** toggle |
| Grok token expired    | Refresh Token or re-login                                                  |
| Video won’t load      | Prefer MP4 H.264                                                           |
| Export fringe         | Raise Spill Suppression / tweak Similarity                                 |

---

## Development notes

- All AI traffic goes through the **local proxy** in `server.js` (CORS + secrets stay off third-party frontends).
- No cloud backend of yours is required — everything runs on the user’s machine.
- SuperGrok uses a public device-code OAuth client (CLI-style); tokens stay in the browser.
- Production UI is the Angular build copied into the packaged `www/` tree.

```bash
npm run build              # client production build
npm run build:windows      # example platform package
npm run build:all          # multi-platform (see package.json)
```

---

## Credits

**AS Adventurer Creator** by [Angel's Sword Studios](https://www.angelssword.com)

Upstream pipeline: [AngelsSwordStudios/angelssword-adventurers-creator](https://github.com/AngelsSwordStudios/angelssword-adventurers-creator)

**AS Adventurer Creator – Angular Edition** by [Ooze Clues](https://x.com/oozeclue)

Built with ❤️ for the VTuber community.
