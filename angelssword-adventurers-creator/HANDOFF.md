# AS Adventurer — VTuber Creation Pipeline Handoff

## Project Overview

**AS Adventurer** is a consolidated VTuber creation pipeline that combines the best of Angel's Sword Studios' existing tools (ASArtTool + Fugi Maker EX) into a single, streamlined, tabbed interface. The target audience is VTubers and streamers — many with low-end hardware — who need a fast, simple way to create animated PNGtuber/VTuber assets.

> [!IMPORTANT]
> **Core Value Proposition**: Drop-dead simple. A total beginner should be able to create a VTuber model from scratch in minutes. Hover tooltips on everything. The tool's simplicity is its advantage over Live2D.

**Workspace**: `H:\Git\devtools\AS Adventurer`

---

## Architecture

- **Single-page web app** — HTML + CSS + JS (no frameworks)
- **Local Node.js server** (`server.js`) — static files + API proxy for OpenAI and Google
- **Launcher**: `.bat` file to start the server
- **All API keys stored in `localStorage`** — never sent to any third party, only to the official API endpoints via the local proxy

---

## Branding & Design System

### Source of Truth
The existing design system lives in [editor.css](file:///H:/Git/devtools/editor.css) (752 lines). All new UI must match this aesthetic.

### Color Palette (CSS Custom Properties)
```css
--bg-deep: #1a1a2e;          /* Main background */
--bg-panel: #16213e;         /* Card/panel background */
--bg-panel-alt: #1b2a4a;     /* Alternate panel */
--bg-input: #0f1a30;         /* Input fields */
--accent-red: #e94560;       /* Danger/warning */
--accent-blue: #0f3460;      /* Interactive/selected */
--accent-gold: #dbb858;      /* PRIMARY BRAND COLOR */
--accent-gold-glow: rgba(219, 184, 88, 0.3);
--text: #e0e0e0;             /* Primary text */
--text-muted: #8899aa;       /* Muted text */
--text-dim: #556677;         /* Dim text */
--border: rgba(255,255,255,0.08);
--border-light: rgba(255,255,255,0.12);
```

### Typography
```css
font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
```
- **Primary font**: Inter
- **Font weights**: 500 (medium) for labels, 600 (semibold) for titles
- **Brand text**: Gold gradient with `background-clip: text`

### Visual Style
| Aspect | Detail |
|:---|:---|
| **Mode** | Dark mode (always) |
| **Brand icon** | ⚔️ (crossed swords) |
| **Brand name** | Angel's Sword Studios |
| **Aesthetic** | Fantasy-meets-modern, anime/JRPG themed |
| **Cards** | Panel-based elevation via background color steps |
| **Border radius** | 4px (small), 8px (default), 12px (large) |
| **Shadows** | `0 4px 20px rgba(0,0,0,0.3)` |
| **Transitions** | `0.2s ease` globally |
| **Active indicators** | Gold left-border bar (3px) |
| **Scrollbars** | Custom thin, subtle white-alpha |

### Existing ASArtTool Style (Alternative Reference)
The ASArtTool at [asarttool.css](file:///H:/Git/devtools/asarttool/asarttool.css) uses a slightly different but compatible theme:
- Fonts: `Cinzel Decorative` (display), `Cinzel` (headings), `Outfit` (body), `Share Tech Mono` (mono)
- Glass panels: `backdrop-filter: blur(20px)`, semi-transparent backgrounds with gold borders
- Tagline: "Design · Generate · Cut · Create"

**Recommendation**: Use the `editor.css` palette but incorporate the `Outfit` body font and `Cinzel` for headings from ASArtTool for a more premium fantasy feel.

---

## Tab Structure (5 Tabs + Settings)

### Tab 1: 🎨 Sprite Prep

**Purpose**: Create or prepare a 1280×720 sprite image with a chroma key background.

**Two Modes**:

#### A. Manual Mode (Upload Your Own)
Carry forward from Fugi Maker EX's sprite prep:
- **Upload PNG** — any resolution
- **Key Color Selector** — 5 swatches: Green (#00FF00), Magenta (#FF00FF), Blue (#0000FF), Yellow (#FFFF00), Cyan (#00FFFF)
- **Optimal Color Auto-Detect** — Analyze uploaded sprite, compute Euclidean RGB distance for each candidate, recommend the one most separated from all sprite colors. Show ⭐ badge on best choice
- **Vertical Offset** slider (-500 to +500 px, persisted to localStorage)
- **Zoom** slider (10% to 300%, persisted to localStorage)
- **Canvas Preview** — 1280×720, key color fill, sprite positioned bottom-anchored
- **Export as 1280×720 PNG**
- **"Send to Generate Video →"** handoff button

> [!NOTE]
> **Removed**: Reference Match feature from Fugi Maker EX — user requested removal.

#### B. Generative Mode (AI Create)
Uses **GPT Image 2** (`gpt-image-2` model) via OpenAI API:

**Inputs**:
- **Character Name** (required)
- **Character Description** (textarea)
- **(Optional) Character Action** — what the character is doing. Defaults prompt to "neutral idle position" if empty
- **(Optional) Art Style Reference** — upload image for style consistency
- **(Optional) Character Reference** — upload image. When provided, auto-detect optimal key color from it
- **Key Color Selector** — same 5 swatches + auto-detect
- **Simultaneous Generations** — selector for 1-4 parallel generations

**Output**: Single 1280×720 image (NOT a grid — see reference image below). Character on solid chroma key background, bottom-anchored.

**Prompt Construction** (based on ASArtTool patterns):
```
A single [character name], [character description], [character action OR "standing in a neutral idle position"]. 
Full body visible from head to toe, centered in frame, positioned in the lower portion of the canvas.
The entire background must be a solid, uniform [key color name] (#hex) with absolutely no gradients, shadows, or variations.
The character should be drawn in a [style description from reference OR "high-quality anime/JRPG art style"].
The image must be exactly 1280×720 pixels.
```

**API Route**: `POST /api/edits` (with images) or `POST /api/generate` (text-only), proxied through local server to OpenAI.

**Reference Image Format** (user provided):
![Sprite reference](file:///C:/Users/Leaflit/.gemini/antigravity/brain/ba710d63-17b4-4e08-8da0-cf1affaaf90e/media__1783469515473.png)
*Single character on solid magenta background, 1280×720, bottom-anchored*

---

### Tab 2: 🎬 Generate Video

> [!TIP]
> Include clear instructions: "Skip this step if you want to use your own video generator (e.g., Veo, RunwayML, etc.)"

**Purpose**: Generate animated videos from the sprite image using Google's Gemini Omni Flash API.

**API**: `gemini-omni-flash-preview` via `interactions.create()` endpoint

**API Endpoint**: `POST https://generativelanguage.googleapis.com/v1beta/interactions`

**Inputs**:
- **Reference Image(s)** — from Sprite Prep handoff or manual upload
- **Two Modes**:
  - **Reference Mode**: Upload 1-3 reference images + text prompt describing desired motion
  - **Keyframe Mode**: Upload Start Frame and End Frame — the model interpolates between them
- **Video Length**: Slider 3–10 seconds
- **Aspect Ratio**: Locked to 16:9
- **Simultaneous Generations**: Selector for 1-4 parallel generations
- **Text Prompt**: Describe the animation (e.g., "gentle breathing idle animation", "talking with mouth open and closing", "waving hand greeting")

**Output**:
- Preview panel showing all generated videos side-by-side
- Checkboxes to select which to keep
- **"Add to Video Preparation →"** handoff button for selected videos
- **Download** individual videos

**API Implementation Notes**:
```javascript
// Omni Flash uses the Interactions API
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/interactions?key=${API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-omni-flash-preview',
      contents: [
        { role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/png', data: base64Image } }
        ]}
      ],
      generationConfig: {
        responseModalities: ['VIDEO'],
        videoDurationSeconds: durationSeconds
      }
    })
  }
);
```
- Response contains video as base64 in `parts[].inlineData` or as a URI via `delivery: "uri"`
- Proxy through server to avoid CORS issues and protect API key
- ~$0.10/second of video output

---

### Tab 3: 🔄 Video Preparation

**Purpose**: Prepare videos for export — loop building, video concatenation, and crossfade.

**Carried from Fugi Maker EX Loop Builder:**
- Upload video (MP4, WebM, MOV)
- Frame-by-frame scrubber with arrow key navigation
- Play/Pause native video playback
- Set loop point with onion skin overlay (frame 0 at 50% opacity)
- **Three export modes**:
  - **No Loop** (DEFAULT — changed from Fugi Maker where Ping-Pong was default)
  - **Loop (Ping-Pong)**: forward + reverse (0 → N → 0)
  - **Reverse on Export**: reversed frames only

**NEW FEATURE — Video Concatenation**:
- **"Add 2nd Video"** button — upload a second video
- Second video is immediately appended seamlessly to the first
- Preview plays both back-to-back
- **Crossfade Option**: Toggle crossfade between the two videos with adjustable duration (100ms–1000ms)

**Output**:
- **"Send to Model Exporter →"** handoff button with all frame data

---

### Tab 4: 📦 Model Exporter

**Purpose**: Final export as WebM or GIF with chroma key removal and size controls.

**Three Modes** (segmented toggle):
| Mode | Default Format | Max Frames | Max Resolution | Restrictions |
|:---|:---|:---|:---|:---|
| **Adventurer** (DEFAULT) | WebM | Unlimited | Unlimited | None |
| **F. Normal** | GIF | 120 | 1000×1000 | Hide WebM option |
| **F. Premium** | GIF | 600 | 4000×4000 | Hide WebM option |

**Carried from Fugi Maker EX Video→GIF:**
- Full chroma key removal pipeline (Ultra Key):
  - Key color picker + eyedropper + auto-detect
  - Similarity (0-100%), Smoothness (0-100%), Spill Suppression (0-100%)
  - Crop overlay with ratio options (Off, 1:1, 4:3)
  - Scale, Vertical Offset, Saturation, Brightness sliders
  - Preview modes: Checker, Black, White, Original
  - Frame scrubber with playback
- Export settings: Start/End frame, Frame Skip, FPS override, Output Width/Height with aspect lock
- **Always show** estimated file size and output frame count at the bottom
- Progress bar with cancel

**NEW FEATURE — Quick Filename Buttons**:
Above the export button, add preset filename buttons:
| Button | Sets filename to |
|:---|:---|
| `Idle` | `{characterName}_idle` |
| `Intro` | `{characterName}_intro` |
| `Outro` | `{characterName}_outro` |
| `Speaking` | `{characterName}_speaking` |
| `Animation` | `{characterName}_animation` |
| `Custom` | Free text input field |

The main export button label: **"Export Transparent Motion"** (previously "Export Transparent Gif")

---

### Tab 5: ⚙️ Settings

**API Key Management**:
- **OpenAI API Key** — password input with show/hide toggle
- **Google Gemini API Key** — password input with show/hide toggle
- Both stored in `localStorage` (clearly state: "Your keys are stored locally in your browser only and never sent to any third party.")
- **TEST CONNECTION** button for each — sends a lightweight test request through the proxy

**Server Launch**:
- Button to launch the `Start ASAdventurer.bat` file
- Info text: "You need to run the local server for AI features. The server acts as a secure proxy for API calls."

**About Section**:
```
⚔️ Angel's Sword Studios

AS Adventurer — VTuber Creation Pipeline
Design → Generate → Prepare → Export

Crafted with ✦ for adventurers everywhere
```

**Product Links**:
- [angelssword.com](https://www.angelssword.com) — Main Web & Streamers
- [rpg.angelssword.com](https://rpg.angelssword.com) — Table Top RPG
- [clio.angelssword.com](https://clio.angelssword.com) — Lore Website

---

## Server Architecture

### server.js (Node.js)

**Port**: 3000 (or configurable)

**Static file serving**: Serve from `public/` directory

**API Proxy Routes**:
| Route | Proxies To | Purpose |
|:---|:---|:---|
| `POST /api/generate` | `https://api.openai.com/v1/images/generations` | GPT Image text-only |
| `POST /api/edits` | `https://api.openai.com/v1/images/edits` | GPT Image with reference images (multipart form-data conversion) |
| `POST /api/chat` | `https://api.openai.com/v1/chat/completions` | Test connection |
| `POST /api/video/generate` | `https://generativelanguage.googleapis.com/v1beta/interactions` | Omni Flash video gen |

**Why proxy?** OpenAI requires server-side requests (CORS blocked from browser). The proxy also keeps the API key out of client-side code.

**Reference implementation**: [server.ps1](file:///H:/Git/devtools/asarttool/server.ps1) (PowerShell version — rewrite as Node.js)

### Start ASAdventurer.bat
```batch
@echo off
color 0E
echo ⚔️  AS Adventurer — VTuber Creation Pipeline
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo Starting server...
cd /d "%~dp0"
node server.js
pause
```

---

## Key Algorithms to Port

### 1. Optimal Color Auto-Detection
**Source**: [sprite-generator.js](file:///H:/Git/devtools/asarttool/sprite-generator.js) `_analyzeReferenceForKeyColor()`

Algorithm:
1. Draw reference image to canvas
2. Sample 5×5 corner pixels to detect existing background
3. Sample every 3rd foreground pixel (skip transparent + near-bg)
4. For each of 5 key colors, compute minimum Manhattan RGB distance from any foreground pixel
5. Highest minimum distance = safest = recommended (⭐ badge)
6. If minDist < 80, show ⚠ Avoid badge

### 2. Chroma Key Engine
**Source**: [fugi-maker.js](file:///H:/Git/devtools/fugi-maker/index.html) `ChromaKey` class (lines 2696-3399)

5-pass pipeline:
1. Edge flood fill (BFS from borders)
2. Interior YCbCr sweep
3. Advanced defringe (7 sub-passes including edge erosion, distance-based alpha matting, spill suppression, interior color propagation, alpha bleeding)

### 3. GIF Encoder
**Source**: Fugi Maker EX — custom GIF89a encoder with LZW compression, delta optimization, transparency support.

### 4. WebM Export
**Source**: Fugi Maker EX — uses `MediaRecorder` API with VP9 codec.

### 5. Loop Builder Frame System
**Source**: Fugi Maker EX — video seek + canvas capture at frame intervals, onion skin overlay, ping-pong generation.

---

## Reference Codebases

| Tool | Path | What to take |
|:---|:---|:---|
| **ASArtTool** | [H:\Git\devtools\asarttool](file:///H:/Git/devtools/asarttool) | Generative AI pipeline, prompt construction, key color system, server proxy, notification sounds, touch-up editor patterns |
| **Fugi Maker EX** | [H:\Git\devtools\fugi-maker](file:///H:/Git/devtools/fugi-maker) | Loop Builder, Video→GIF pipeline, ChromaKey engine, GIF encoder/decoder, WebM export, sprite prep canvas system |
| **Design System** | [H:\Git\devtools\editor.css](file:///H:/Git/devtools/editor.css) | CSS variables, component patterns, branding |

---

## UX Requirements

1. **Tooltips on EVERYTHING** — every button, every slider, every input should have a hover tooltip explaining what it does in plain language
2. **Step indicators** — numbered badges (①②③④) showing the pipeline flow
3. **Handoff buttons** — clear "Send to Next Step →" buttons between tabs
4. **Progress indicators** — for all AI generation and export operations
5. **Error messages** — clear, actionable (e.g., "No API key set. Go to Settings to add your OpenAI key.")
6. **Responsive** — grid collapses at 640px
7. **Dark mode always** — matches brand
8. **Keyboard shortcuts** — arrow keys for frame navigation, Escape to cancel

---

## File Structure (Target)
```
H:\Git\devtools\AS Adventurer\
├── server.js                 # Node.js server + API proxy
├── package.json              # Dependencies (express, node-fetch, form-data)
├── Start ASAdventurer.bat    # Launcher
├── public/
│   ├── index.html            # Single-page app
│   ├── style.css             # Design system + all component styles
│   ├── app.js                # Main app controller, tab switching, settings
│   ├── sprite-prep.js        # Tab 1: Sprite Prep (manual + generative)
│   ├── video-gen.js          # Tab 2: Generate Video (Omni Flash)
│   ├── video-prep.js         # Tab 3: Video Preparation (loop builder + concat)
│   ├── model-exporter.js     # Tab 4: Model Exporter (chroma key + export)
│   └── assets/
│       └── (favicon, mascot, sounds, references)
```
