# Legacy vanilla UI (reference only)

These trees are **not** used by the active Angular app, `npm start` (when the client is built), or release packages that embed `www/` from the Angular build.

They exist so forks and maintainers can compare against the original single-page vanilla pipeline.

## Layout

Relative paths inside each snapshot are preserved so you can open or serve that folder on its own if needed.

```
legacy/
├── public/                 # Complete vanilla SPA (formerly repo-root public/)
│   ├── index.html          # loads sibling scripts + style.css
│   ├── app.js
│   ├── style.css
│   ├── sprite-prep.js
│   ├── video-gen.js
│   ├── video-prep.js
│   ├── model-exporter.js
│   └── assets/             # logo + notification sounds (same assets as client/public)
│
└── vanilla/                # Alternate script snapshot (formerly legacy-vanilla/)
    ├── index.html
    ├── app.js
    ├── sprite-prep.js
    ├── video-gen.js        # differs from public/video-gen.js
    ├── video-prep.js       # differs from public/video-prep.js
    └── model-exporter.js
```

### `legacy/public/`

Full last-known vanilla UI that used to live at the repository root as `public/`. Script tags and `assets/` URLs are relative to this folder.

### `legacy/vanilla/`

Earlier/alternate dump of the same modules (previously `legacy-vanilla/`). It does **not** include `style.css` or `assets/`; for a runnable tree, prefer `legacy/public/`, or copy those from `legacy/public/` if you need this variant’s scripts.

## Active app locations

| Role | Path |
| ---- | ---- |
| Primary UI | `client/` (Angular) |
| Static assets for Angular | `client/public/` |
| Dev / production static serve | `client/dist/...` or packaged `www/` |
| API + export | `server.js` |

Do not reintroduce a root-level `public/` unless you intentionally want a non-Angular static fallback again.
