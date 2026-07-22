/**
 * ⚔️ AS Adventurer — Local Server + API Proxy
 * Angel's Sword Studios
 * 
 * Serves static UI (www/ or Angular client dist) and proxies API requests
 * to OpenAI and Google Gemini to avoid CORS issues and protect API keys.
 */

const express = require('express');
// node-fetch v2 — kept for multipart FormData (OpenAI image edits).
// Large JSON bodies (xAI image data-URIs) use Node's native fetch / undici instead;
// node-fetch has been observed to throw TLS "bad record mac" on multi-MB POSTs.
const nodeFetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const comfy = require('./comfy');
const { mkExportTemp } = require('./lib/export-temp.cjs');
const {
    ensureFfmpeg,
    resolveFfmpegPathSync,
    probeVersionLine,
} = require('./lib/ensure-ffmpeg.cjs');

const app = express();
const PORT = process.env.PORT || 3001;

/** Built-in fetch (Node 18+ / undici). Better TLS for large request bodies. */
const undiciFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;

/** Shared HTTPS agent: no keep-alive (avoids bad TLS session reuse on big uploads). */
const httpsNoKeepAlive = new https.Agent({
    keepAlive: false,
    maxVersion: 'TLSv1.3',
    minVersion: 'TLSv1.2',
});

function isRetryableNetworkError(err) {
    const msg = String((err && err.message) || err || '');
    const code = String((err && err.code) || '');
    return /SSL|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|socket hang up|bad record mac|TLS|network|aborted|UND_ERR/i.test(
        msg + ' ' + code
    );
}

/**
 * Upstream HTTP(S) for JSON APIs with retries on transient TLS/network failures.
 * Prefer native fetch; fall back to node-fetch with keepAlive disabled.
 */
async function fetchUpstream(url, options = {}, meta = {}) {
    const {
        retries = 3,
        timeoutMs = 300000,
        label = 'upstream',
    } = meta;

    const headers = {
        Accept: 'application/json',
        Connection: 'close',
        ...(options.headers || {}),
    };

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            if (attempt > 1) {
                const delay = 500 * attempt;
                console.log(`  [PROXY] ${label} retry ${attempt}/${retries} after ${delay}ms…`);
                await new Promise((r) => setTimeout(r, delay));
            }

            if (undiciFetch) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    return await undiciFetch(url, {
                        method: options.method || 'GET',
                        headers,
                        body: options.body,
                        signal: controller.signal,
                        // undici option: don't reuse the connection for the next request
                        keepalive: false,
                    });
                } finally {
                    clearTimeout(timer);
                }
            }

            // Fallback path (older Node / no global fetch)
            return await nodeFetch(url, {
                method: options.method || 'GET',
                headers,
                body: options.body,
                timeout: timeoutMs,
                agent: String(url).startsWith('https') ? httpsNoKeepAlive : undefined,
            });
        } catch (err) {
            lastErr = err;
            console.error(`  [ERROR] ${label} attempt ${attempt}/${retries}:`, err.message);
            if (!isRetryableNetworkError(err) || attempt === retries) {
                throw err;
            }
        }
    }
    throw lastErr;
}

/** node-fetch wrapper for multipart / legacy callers (OpenAI FormData). */
function fetch(url, options = {}) {
    const opts = { ...options };
    if (String(url).startsWith('https') && !opts.agent) {
        opts.agent = httpsNoKeepAlive;
    }
    return nodeFetch(url, opts);
}

// --- Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS headers for all responses
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    // DELETE used by WebM export session cancel
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    // X-API-Key is used for Gemini Interactions (image + video)
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Static files — pkg release uses www/ next to the binary; dev uses Angular client dist.
// Vanilla UI snapshots live under legacy/ and are not served here.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const staticCandidates = [
    path.join(APP_DIR, 'www'),
    path.join(APP_DIR, 'client', 'dist', 'client', 'browser'),
    path.join(APP_DIR, 'client', 'dist', 'browser'),
];
const staticRoot = staticCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
if (!staticRoot) {
    console.warn(
        '  [static] No UI found (www/ or client/dist). Run: npm run build --prefix client\n' +
            '           Legacy vanilla UI is under legacy/public/ (reference only).'
    );
} else {
    app.use(express.static(staticRoot));
}

// --- API Proxy Routes ---

/**
 * POST /api/generate
 * Proxies to OpenAI Image Generations (text-only, no reference images)
 * Body: { model, prompt, n, size, quality }
 */
app.post('/api/generate', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'No Authorization header provided' });
    }

    try {
        console.log('  [PROXY] POST /api/generate →  OpenAI /v1/images/generations');
        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify(req.body),
            timeout: 300000
        });

        const data = await response.text();
        console.log(`  [PROXY] /v1/images/generations → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] Generate proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/edits
 * Proxies to OpenAI Image Edits (with reference images)
 * Converts JSON body { model, prompt, images[], n, size, quality }
 * into multipart/form-data as required by OpenAI API.
 * 
 * Images can be:
 *   - Raw base64 strings
 *   - Objects { label: "character_reference", data: "base64..." }
 */
app.post('/api/edits', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'No Authorization header provided' });
    }

    try {
        console.log('  [PROXY] POST /api/edits → OpenAI /v1/images/edits');
        const { model, prompt, images, n, size, quality } = req.body;

        const form = new FormData();
        form.append('model', model || 'gpt-image-2');
        form.append('prompt', prompt);
        if (n) form.append('n', String(n));
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);

        // Add images as file fields
        if (images && Array.isArray(images)) {
            images.forEach((imgEntry, index) => {
                let raw, fileName;

                if (typeof imgEntry === 'object' && imgEntry.data) {
                    // Labeled image: { label: "character_reference", data: "base64..." }
                    raw = imgEntry.data;
                    fileName = `${imgEntry.label || 'ref' + index}.png`;
                } else {
                    // Raw base64 string
                    raw = String(imgEntry);
                    fileName = `ref${index}.png`;
                }

                // Strip data URI prefix if present
                if (raw.includes(',')) {
                    raw = raw.substring(raw.indexOf(',') + 1);
                }

                const imgBuffer = Buffer.from(raw, 'base64');
                form.append('image[]', imgBuffer, {
                    filename: fileName,
                    contentType: 'image/png'
                });
                console.log(`    [IMG] ${fileName} (${imgBuffer.length} bytes)`);
            });
        }

        const response = await fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                ...form.getHeaders()
            },
            body: form,
            timeout: 300000
        });

        const data = await response.text();
        console.log(`  [PROXY] /v1/images/edits → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] Edits proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/chat
 * Proxies to OpenAI Chat Completions (used for test connection)
 * Body: Standard OpenAI chat completion body
 */
app.post('/api/chat', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'No Authorization header provided' });
    }

    try {
        console.log('  [PROXY] POST /api/chat → OpenAI /v1/chat/completions');
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify(req.body),
            timeout: 30000
        });

        const data = await response.text();
        console.log(`  [PROXY] /v1/chat/completions → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] Chat proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/video/generate
 * Proxies to Google Gemini Interactions API (video + image models).
 * Body: Interactions request — { model, input, response_format, generation_config, ... }
 * Expects Google API key in X-API-Key header or ?key=
 */
app.post('/api/video/generate', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (!apiKey) {
        return res.status(401).json({ error: 'No Google API key provided' });
    }

    try {
        const modelName = (req.body && req.body.model) || '(model)';
        console.log(`  [PROXY] POST /api/video/generate → Gemini Interactions (${modelName})`);

        // Log the request body (redact image/video base64 for readability)
        const logBody = JSON.parse(JSON.stringify(req.body || {}));
        const redactInput = (item) => {
            if (!item || typeof item !== 'object') return item;
            if (item.data && typeof item.data === 'string' && item.data.length > 80) {
                return { ...item, data: `[${item.data.length} chars base64]` };
            }
            return item;
        };
        if (Array.isArray(logBody.input)) {
            logBody.input = logBody.input.map(redactInput);
        }
        if (logBody.input_image) {
            logBody.input_image = redactInput(logBody.input_image);
        }
        console.log('  [PROXY] Request body:', JSON.stringify(logBody, null, 2));

        const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;
        console.log('  [PROXY] URL:', url.replace(apiKey, apiKey.substring(0, 8) + '...'));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(req.body),
            timeout: 600000 // 10 min timeout for video / image generation
        });

        let data = await response.text();
        console.log(`  [PROXY] Gemini Interactions → HTTP ${response.status}`);

        // Normalize Google error bodies: Interactions sometimes returns
        // [{ error: { message, code, ... } }] instead of { error: {...} }.
        // Unwrap so clients can read error.error.message consistently.
        if (response.status !== 200) {
            try {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed) && parsed[0] && parsed[0].error) {
                    data = JSON.stringify(parsed[0]);
                }
            } catch {
                /* keep raw text */
            }
            console.error('  [ERROR] Gemini API error response:');
            console.error('  ', data.substring(0, 800));
        } else {
            const sizeMB = (data.length / 1024 / 1024).toFixed(1);
            console.log(`  [PROXY] ✅ Gemini Interactions OK (${sizeMB} MB response)`);
            // Helpful debug: which step types came back (no base64 dump)
            try {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed.steps)) {
                    const types = parsed.steps.map((s) => s && s.type).filter(Boolean);
                    console.log(`  [PROXY] steps: [${types.join(', ')}] status=${parsed.status || '?'}`);
                } else if (parsed.outputs) {
                    console.log(`  [PROXY] legacy outputs count=${parsed.outputs.length}`);
                } else {
                    console.log(`  [PROXY] top-level keys: ${Object.keys(parsed).slice(0, 12).join(', ')}`);
                }
            } catch {
                /* ignore */
            }
        }

        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] Video generate proxy failed:', err.message);
        console.error('  [ERROR] Stack:', err.stack);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/video/poll
 * Polls a Gemini Interactions operation for completion
 */
app.post('/api/video/poll', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (!apiKey) {
        return res.status(401).json({ error: 'No Google API key provided' });
    }

    try {
        const { operationName } = req.body;
        if (!operationName) {
            return res.status(400).json({ error: 'No operationName provided' });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
        const response = await fetch(url, { method: 'GET', timeout: 30000 });
        const data = await response.text();
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] Video poll failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

// --- xAI Grok Imagine proxies ---
//
// API-key and SuperGrok OAuth both send Authorization: Bearer <token> on generation
// routes. OAuth device/token exchange is proxied here so the browser never talks to
// auth.x.ai directly (CORS + keeps the public client id in one place).

/** Public device-code client used by CLI-style SuperGrok tools (not a secret). */
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';

/**
 * POST /api/xai/oauth/device — start SuperGrok device-code login
 */
app.post('/api/xai/oauth/device', async (req, res) => {
    try {
        console.log('  [PROXY] POST /api/xai/oauth/device → auth.x.ai device/code');
        const body = new URLSearchParams({
            client_id: XAI_OAUTH_CLIENT_ID,
            scope: XAI_OAUTH_SCOPE,
            referrer: 'as-adventurer',
        });
        const response = await fetch(XAI_DEVICE_CODE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-grok-client-version': '1.0.0',
                'x-grok-client-surface': 'cli',
            },
            body: body.toString(),
        });
        const data = await response.text();
        console.log(`  [PROXY] xAI device/code → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI OAuth device failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/xai/oauth/token — device_code poll or refresh_token exchange
 * Body JSON: { grant_type, device_code? } or { grant_type: 'refresh_token', refresh_token }
 */
app.post('/api/xai/oauth/token', async (req, res) => {
    try {
        const grantType = (req.body && req.body.grant_type) || '(missing)';
        console.log(`  [PROXY] POST /api/xai/oauth/token → auth.x.ai  grant_type=${grantType}`);
        const params = new URLSearchParams({
            client_id: XAI_OAUTH_CLIENT_ID,
            ...(req.body || {}),
        });
        if (!params.has('client_id')) params.set('client_id', XAI_OAUTH_CLIENT_ID);

        const response = await fetch(XAI_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-grok-client-version': '1.0.0',
                'x-grok-client-surface': 'cli',
            },
            body: params.toString(),
        });
        const data = await response.text();
        console.log(`  [PROXY] xAI token → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI OAuth token failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * Normalize Authorization for xAI: always "Bearer <key>", strip quotes / double Bearer.
 * Returns null if missing.
 */
function xaiAuth(req) {
    let raw = req.headers['authorization'] || req.headers['x-api-key'] || req.query.key || '';
    if (Array.isArray(raw)) raw = raw[0] || '';
    raw = String(raw).trim();
    if (!raw) return null;

    // Strip accidental wrapping quotes from pasted keys
    if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
    ) {
        raw = raw.slice(1, -1).trim();
    }

    // Accept raw key or "Bearer …" (also collapse double Bearer)
    raw = raw.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return null;
    return `Bearer ${raw}`;
}

function xaiAuthPreview(auth) {
    if (!auth) return '(none)';
    const key = auth.replace(/^Bearer\s+/i, '');
    if (key.length <= 12) return `Bearer ${key.slice(0, 4)}…`;
    return `Bearer ${key.slice(0, 8)}…${key.slice(-4)} (len=${key.length})`;
}

function redactXaiBody(body) {
    try {
        const logBody = JSON.parse(JSON.stringify(body || {}));
        const redactUrl = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            if (typeof obj.url === 'string' && obj.url.length > 80) {
                return { ...obj, url: `[${obj.url.slice(0, 32)}… ${obj.url.length} chars]` };
            }
            return obj;
        };
        if (logBody.image) {
            logBody.image = Array.isArray(logBody.image)
                ? logBody.image.map(redactUrl)
                : redactUrl(logBody.image);
        }
        if (Array.isArray(logBody.images)) {
            logBody.images = logBody.images.map(redactUrl);
        }
        if (Array.isArray(logBody.reference_images)) {
            logBody.reference_images = logBody.reference_images.map(redactUrl);
        }
        if (logBody.video) logBody.video = redactUrl(logBody.video);
        return logBody;
    } catch {
        return { note: '(could not redact body)' };
    }
}

/**
 * GET /api/xai/models — list models (legacy connection probe)
 */
app.get('/api/xai/models', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        console.log(`  [PROXY] GET /api/xai/models → xAI  auth=${xaiAuthPreview(auth)}`);
        const response = await fetchUpstream(
            'https://api.x.ai/v1/models',
            {
                method: 'GET',
                headers: { Authorization: auth },
            },
            { label: 'xAI models', timeoutMs: 30000, retries: 2 }
        );
        const data = await response.text();
        console.log(`  [PROXY] xAI /v1/models → ${response.status}`);
        if (response.status !== 200) {
            console.error('  [ERROR]', data.substring(0, 800));
        }
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI models proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/xai/test — connection test that exercises a real inference call.
 * GET /v1/models sometimes 403s for scoped / Imagine-only keys; a tiny chat
 * completion is a better "does this key work?" check. Falls back to models list.
 */
app.post('/api/xai/test', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        console.log(`  [PROXY] POST /api/xai/test → xAI chat  auth=${xaiAuthPreview(auth)}`);

        // Tiny chat completion — validates key + billing without Imagine cost.
        const chatBody = {
            model: 'grok-3-mini',
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            max_tokens: 5,
            temperature: 0,
        };

        let response = await fetchUpstream(
            'https://api.x.ai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    Authorization: auth,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(chatBody),
            },
            { label: 'xAI chat test', timeoutMs: 60000, retries: 2 }
        );
        let data = await response.text();
        console.log(`  [PROXY] xAI chat/completions → ${response.status}`);

        // Fallback model id if grok-3-mini is unavailable
        if (response.status === 404 || (response.status === 400 && /model/i.test(data))) {
            console.log('  [PROXY] Retrying test with model=grok-2-latest');
            chatBody.model = 'grok-2-latest';
            response = await fetchUpstream(
                'https://api.x.ai/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        Authorization: auth,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(chatBody),
                },
                { label: 'xAI chat test retry', timeoutMs: 60000, retries: 2 }
            );
            data = await response.text();
            console.log(`  [PROXY] xAI chat/completions (retry) → ${response.status}`);
        }

        // Last resort: models list (some teams only allow this)
        if (response.status === 403 || response.status === 404) {
            console.log('  [PROXY] Falling back to GET /v1/models for test');
            const modelsResp = await fetchUpstream(
                'https://api.x.ai/v1/models',
                {
                    method: 'GET',
                    headers: { Authorization: auth },
                },
                { label: 'xAI models fallback', timeoutMs: 30000, retries: 2 }
            );
            const modelsData = await modelsResp.text();
            console.log(`  [PROXY] xAI /v1/models → ${modelsResp.status}`);
            if (modelsResp.status === 200) {
                return res.status(200).json({ ok: true, via: 'models' });
            }
            // Prefer the chat error if models also failed — usually more specific
            if (response.status !== 200) {
                console.error('  [ERROR] chat:', data.substring(0, 600));
                console.error('  [ERROR] models:', modelsData.substring(0, 600));
                // Merge into a clearer client error
                let msg = 'xAI rejected this API key (HTTP 403).';
                try {
                    const parsed = JSON.parse(data || modelsData);
                    msg =
                        (parsed.error && (parsed.error.message || parsed.error)) ||
                        parsed.message ||
                        msg;
                    if (typeof msg !== 'string') msg = JSON.stringify(msg);
                } catch {
                    /* keep default */
                }
                return res.status(403).json({
                    error: {
                        message:
                            `${msg} Check that the key is from console.x.ai, has API access enabled, ` +
                            `and the team has billing/credits. Keys can take a minute after creation.`,
                        code: 403,
                    },
                });
            }
        }

        if (response.status !== 200) {
            console.error('  [ERROR]', data.substring(0, 800));
        }
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI test proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/xai/images/generations — Grok Imagine text-to-image
 * Docs: https://docs.x.ai/developers/model-capabilities/images/generation
 */
app.post('/api/xai/images/generations', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        const payload = JSON.stringify(req.body);
        console.log(
            `  [PROXY] POST /api/xai/images/generations → xAI (${(payload.length / 1024).toFixed(0)} KB)`
        );
        console.log('  [PROXY] Request body:', JSON.stringify(redactXaiBody(req.body), null, 2));
        const response = await fetchUpstream(
            'https://api.x.ai/v1/images/generations',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: auth,
                },
                body: payload,
            },
            { label: 'xAI images/generations', timeoutMs: 300000, retries: 3 }
        );
        const data = await response.text();
        console.log(`  [PROXY] xAI images/generations → ${response.status}`);
        if (response.status !== 200) {
            console.error('  [ERROR]', data.substring(0, 800));
        }
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI image generate proxy failed:', err.message);
        res.status(502).json({
            error: `Proxy error: ${err.message}`,
            hint: 'TLS/network failure talking to xAI. Retry — large reference images are retried automatically.',
        });
    }
});

/**
 * POST /api/xai/images/edits — Grok Imagine image edit / multi-ref
 * Docs: https://docs.x.ai/developers/model-capabilities/images/editing
 * Body is JSON (not multipart) with image / images as { url, type } objects.
 */
app.post('/api/xai/images/edits', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        const payload = JSON.stringify(req.body);
        console.log(
            `  [PROXY] POST /api/xai/images/edits → xAI (${(payload.length / 1024).toFixed(0)} KB)`
        );
        console.log('  [PROXY] Request body:', JSON.stringify(redactXaiBody(req.body), null, 2));
        const response = await fetchUpstream(
            'https://api.x.ai/v1/images/edits',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: auth,
                },
                body: payload,
            },
            { label: 'xAI images/edits', timeoutMs: 300000, retries: 3 }
        );
        const data = await response.text();
        console.log(`  [PROXY] xAI images/edits → ${response.status}`);
        if (response.status !== 200) {
            console.error('  [ERROR]', data.substring(0, 800));
        }
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI image edits proxy failed:', err.message);
        res.status(502).json({
            error: `Proxy error: ${err.message}`,
            hint: 'TLS/network failure on large image upload. References are downscaled client-side; retry if this persists.',
        });
    }
});

/**
 * POST /api/xai/videos/generations — start Grok video job (returns request_id)
 * Docs: https://docs.x.ai/developers/model-capabilities/video/generation
 */
app.post('/api/xai/videos/generations', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        const payload = JSON.stringify(req.body);
        console.log(
            `  [PROXY] POST /api/xai/videos/generations → xAI (${(payload.length / 1024).toFixed(0)} KB)`
        );
        console.log('  [PROXY] Request body:', JSON.stringify(redactXaiBody(req.body), null, 2));
        const response = await fetchUpstream(
            'https://api.x.ai/v1/videos/generations',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: auth,
                },
                body: payload,
            },
            { label: 'xAI videos/generations', timeoutMs: 180000, retries: 3 }
        );
        const data = await response.text();
        console.log(`  [PROXY] xAI videos/generations → ${response.status}`);
        if (response.status !== 200) {
            console.error('  [ERROR]', data.substring(0, 800));
        }
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI video generate proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * GET /api/xai/videos/:requestId — poll Grok video job
 */
app.get('/api/xai/videos/:requestId', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    try {
        const requestId = encodeURIComponent(req.params.requestId);
        console.log(`  [PROXY] GET /api/xai/videos/${requestId} → xAI`);
        const response = await fetchUpstream(
            `https://api.x.ai/v1/videos/${requestId}`,
            {
                method: 'GET',
                headers: { Authorization: auth },
            },
            { label: 'xAI video poll', timeoutMs: 60000, retries: 2 }
        );
        const data = await response.text();
        console.log(`  [PROXY] xAI videos/${requestId} → ${response.status}`);
        res.status(response.status).type('application/json').send(data);
    } catch (err) {
        console.error('  [ERROR] xAI video poll proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

/**
 * POST /api/xai/fetch-url — download a temporary media URL (image/video) server-side
 * Body: { url: string } → binary stream (avoids browser CORS on xAI CDN)
 */
app.post('/api/xai/fetch-url', async (req, res) => {
    const auth = xaiAuth(req);
    if (!auth) return res.status(401).json({ error: 'No xAI Authorization header provided' });

    const targetUrl = req.body && req.body.url;
    if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).json({ error: 'No url provided' });
    }
    // Only allow xAI / known media hosts
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid url' });
    }
    const host = parsed.hostname.toLowerCase();
    const allowed =
        host.endsWith('.x.ai') ||
        host === 'x.ai' ||
        host.endsWith('.x.ai.com') ||
        host.includes('x.ai');
    if (!allowed) {
        return res.status(400).json({ error: `URL host not allowed: ${host}` });
    }

    try {
        console.log(`  [PROXY] POST /api/xai/fetch-url → ${host}`);
        const response = await fetchUpstream(
            targetUrl,
            {
                method: 'GET',
                headers: { Authorization: auth },
            },
            { label: 'xAI fetch-url', timeoutMs: 600000, retries: 3 }
        );
        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error(`  [ERROR] fetch-url HTTP ${response.status}:`, errText.substring(0, 400));
            return res.status(response.status).json({
                error: `Failed to download media (HTTP ${response.status})`,
            });
        }
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        // undici Response has arrayBuffer(); node-fetch has buffer()
        let buf;
        if (typeof response.arrayBuffer === 'function') {
            buf = Buffer.from(await response.arrayBuffer());
        } else if (typeof response.buffer === 'function') {
            buf = await response.buffer();
        } else {
            const ab = await response.arrayBuffer();
            buf = Buffer.from(ab);
        }
        console.log(`  [PROXY] ✅ fetch-url OK (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${contentType})`);
        res.status(200).type(contentType).send(buf);
    } catch (err) {
        console.error('  [ERROR] xAI fetch-url proxy failed:', err.message);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
});

// ─── Transparent WebM export (ffmpeg) ─────────────────────────────
// Client chroma-keys frames (PNG or raw RGBA); server packs them into
// VP9 WebM with real alpha. Avoids Firefox MediaRecorder alpha bugs.
//
// Routes used by model-exporter.engine.ts (Adventurer mode):
//   POST   /api/export/session              body: { format?: 'png'|'rgba', width?, height? }
//   POST   /api/export/session/:id/frame?index=N  (PNG or raw RGBA body)
//   POST   /api/export/session/:id/finalize
//   DELETE /api/export/session/:id
//   GET    /api/export/status
//   POST   /api/export/webm  (legacy bulk upload)

const FFMPEG_MAX_FRAMES = 2000;

/** Cached path after ensureFfmpeg (startup or first export). */
let cachedFfmpegPath = null;
let ensureFfmpegPromise = null;

/**
 * Locate ffmpeg for transparent WebM export (no network).
 * Prefer managed bin/ next to the app or user cache, then ffmpeg-static (dev), then PATH.
 */
function resolveFfmpegPath() {
    if (cachedFfmpegPath) return cachedFfmpegPath;
    return resolveFfmpegPathSync(APP_DIR);
}

/**
 * Ensure a current ffmpeg is present (download / upgrade if needed).
 * Safe to call multiple times; concurrent callers share one promise.
 */
function ensureFfmpegReady(opts = {}) {
    if (!ensureFfmpegPromise) {
        ensureFfmpegPromise = ensureFfmpeg({
            appDir: APP_DIR,
            quiet: opts.quiet !== false,
        })
            .then((result) => {
                if (result.path) {
                    cachedFfmpegPath = result.path;
                } else {
                    // Allow a later export to retry download
                    ensureFfmpegPromise = null;
                }
                return result;
            })
            .catch((err) => {
                ensureFfmpegPromise = null;
                throw err;
            });
    }
    return ensureFfmpegPromise;
}

function probeFfmpeg() {
    const ffmpegPath = resolveFfmpegPath();
    return new Promise((resolve) => {
        execFile(ffmpegPath, ['-version'], { timeout: 8000 }, (err, stdout) => {
            if (err) {
                resolve({ available: false, path: ffmpegPath, error: err.message });
                return;
            }
            const firstLine = String(stdout || '').split('\n')[0] || '';
            resolve({ available: true, path: ffmpegPath, version: firstLine.trim() });
        });
    });
}

/** Probe, and if missing try one ensure/download pass. */
async function probeFfmpegOrEnsure() {
    let probe = await probeFfmpeg();
    if (probe.available) return probe;
    try {
        const result = await ensureFfmpegReady({ quiet: false });
        if (result.path) {
            cachedFfmpegPath = result.path;
            probe = await probeFfmpeg();
        }
    } catch (_) {
        /* keep original probe */
    }
    return probe;
}

function rmDirSafe(dir) {
    if (!dir) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
        /* ignore */
    }
}

function runFfmpeg(ffmpegPath, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 20000) stderr = stderr.slice(-12000);
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) resolve({ stderr });
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
        });
    });
}

app.get('/api/export/status', async (_req, res) => {
    try {
        const probe = await probeFfmpegOrEnsure();
        res.json({
            ffmpeg: probe.available,
            path: probe.path,
            version: probe.version || null,
            error: probe.error || null,
            maxFrames: FFMPEG_MAX_FRAMES,
            streaming: true,
        });
    } catch (err) {
        res.status(500).json({ ffmpeg: false, error: err.message });
    }
});

// --- Local ComfyUI (discovery + template workflows + generation) ---
comfy.registerRoutes(app);

// ── Shared export logging (timestamps for debugging) ───────────────
function exportLog(msg, extra = '') {
    const ts = new Date().toISOString();
    console.log(`${ts}  [EXPORT] ${msg}${extra ? ' ' + extra : ''}`);
}
function exportLogError(msg, extra = '') {
    const ts = new Date().toISOString();
    console.error(`${ts}  [EXPORT][ERROR] ${msg}${extra ? ' ' + extra : ''}`);
}

// ── Session export: stream frames to disk as the browser extracts them ──
// POST   /api/export/session              → { sessionId, format }
// POST   /api/export/session/:id/frame?index=N  (PNG or raw RGBA)
// POST   /api/export/session/:id/finalize → { fps, frameCount } → video/webm
// DELETE /api/export/session/:id          → cancel / cleanup

/**
 * @typedef {{ dir: string, frames: number, created: number, format: 'png'|'rgba', width: number, height: number }} ExportSession
 * @type {Map<string, ExportSession>}
 */
const exportSessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function getExportSession(id) {
    return exportSessions.get(id) || null;
}

function destroyExportSession(id) {
    const session = exportSessions.get(id);
    if (!session) return;
    exportSessions.delete(id);
    rmDirSafe(session.dir);
}

// Reap abandoned sessions
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of exportSessions) {
        if (now - s.created > SESSION_TTL_MS) {
            exportLog(`Reaping stale session ${id}`);
            destroyExportSession(id);
        }
    }
}, 5 * 60 * 1000).unref?.();

function frameFileName(index, format) {
    const pad = String(index).padStart(5, '0');
    return format === 'rgba' ? `frame_${pad}.rgba` : `frame_${pad}.png`;
}

function encodeWebmFromPngDir(exportDir, frameCount, fps) {
    const outPath = path.join(exportDir, 'out.webm');
    const ffmpegPath = resolveFfmpegPath();
    const args = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(fps),
        '-start_number',
        '0',
        '-i',
        path.join(exportDir, 'frame_%05d.png'),
        '-frames:v',
        String(frameCount),
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-auto-alt-ref',
        '0',
        '-b:v',
        '0',
        '-crf',
        '28',
        '-deadline',
        'good',
        '-cpu-used',
        '2',
        '-an',
        outPath,
    ];
    return runFfmpeg(ffmpegPath, args, exportDir).then(() => outPath);
}

/**
 * Raw RGBA frames (no PNG) → VP9+alpha.
 *
 * ffmpeg's rawvideo demuxer does NOT support frame_%05d.rgba sequences the way
 * image2 supports PNGs. Stream concatenated frame files into stdin instead.
 */
function encodeWebmFromRgbaDir(exportDir, frameCount, fps, width, height) {
    const outPath = path.join(exportDir, 'out.webm');
    const ffmpegPath = resolveFfmpegPath();
    const expectedBytes = width * height * 4;
    const args = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        `${width}x${height}`,
        '-framerate',
        String(fps),
        '-i',
        'pipe:0',
        '-frames:v',
        String(frameCount),
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-auto-alt-ref',
        '0',
        '-b:v',
        '0',
        '-crf',
        '28',
        '-deadline',
        'good',
        '-cpu-used',
        '2',
        '-an',
        outPath,
    ];

    return new Promise((resolve, reject) => {
        let settled = false;
        const ok = (v) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
        };

        const child = spawn(ffmpegPath, args, {
            cwd: exportDir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 20000) stderr = stderr.slice(-12000);
        });
        child.on('error', (err) => fail(err));
        child.on('close', (code) => {
            if (code === 0) ok(outPath);
            else fail(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
        });

        const stdin = child.stdin;
        let i = 0;
        const failWrite = (err) => {
            try {
                stdin.destroy();
            } catch (_) {
                /* ignore */
            }
            // Kill ffmpeg so close fires; fail() is idempotent with settled.
            try {
                child.kill('SIGTERM');
            } catch (_) {
                /* ignore */
            }
            fail(err);
        };

        const pump = () => {
            if (settled) return;
            try {
                while (i < frameCount) {
                    const name = frameFileName(i, 'rgba');
                    const p = path.join(exportDir, name);
                    let buf;
                    try {
                        buf = fs.readFileSync(p);
                    } catch (err) {
                        failWrite(new Error(`Missing/unreadable ${name}: ${err.message}`));
                        return;
                    }
                    if (buf.length !== expectedBytes) {
                        failWrite(
                            new Error(
                                `${name}: expected ${expectedBytes} bytes, got ${buf.length}`
                            )
                        );
                        return;
                    }
                    i++;
                    if (!stdin.write(buf)) {
                        stdin.once('drain', pump);
                        return;
                    }
                }
                stdin.end();
            } catch (err) {
                failWrite(err);
            }
        };

        pump();
    });
}

/** @deprecated name kept for legacy bulk route */
function encodeWebmFromDir(exportDir, frameCount, fps) {
    return encodeWebmFromPngDir(exportDir, frameCount, fps);
}

app.post('/api/export/session', async (req, res) => {
    try {
        const probe = await probeFfmpegOrEnsure();
        if (!probe.available) {
            return res.status(503).json({
                error:
                    'ffmpeg not found. The app will try to download it on startup; check network, or place ffmpeg in bin/ next to the app, set FFMPEG_PATH, or run: npm run ensure-ffmpeg',
                path: probe.path,
            });
        }
        const format = req.body?.format === 'rgba' ? 'rgba' : 'png';
        const width = parseInt(req.body?.width, 10) || 0;
        const height = parseInt(req.body?.height, 10) || 0;
        if (format === 'rgba' && (width < 1 || height < 1 || width > 8192 || height > 8192)) {
            return res.status(400).json({
                error: 'RGBA sessions require valid width/height (1–8192)',
            });
        }
        const sessionId = crypto.randomBytes(16).toString('hex');
        // Prefer disk-backed temp (avoid WSL /tmp tmpfs ENOSPC)
        const { dir: sessDir } = mkExportTemp(APP_DIR, 'as-export-');
        exportSessions.set(sessionId, {
            dir: sessDir,
            frames: 0,
            created: Date.now(),
            format,
            width,
            height,
        });
        exportLog(
            `Session ${sessionId} opened → ${sessDir} (${format}${format === 'rgba' ? ` ${width}x${height}` : ''})`
        );
        res.json({
            sessionId,
            maxFrames: FFMPEG_MAX_FRAMES,
            format,
            width: format === 'rgba' ? width : null,
            height: format === 'rgba' ? height : null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create export session' });
    }
});

// Frame body: PNG or raw RGBA (application/octet-stream)
app.post(
    '/api/export/session/:id/frame',
    express.raw({
        type: ['image/png', 'application/octet-stream', 'image/x-rgba'],
        limit: '80mb',
    }),
    (req, res) => {
        const session = getExportSession(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Unknown or expired export session' });
        }

        const index = parseInt(req.query.index, 10);
        if (!Number.isFinite(index) || index < 0 || index >= FFMPEG_MAX_FRAMES) {
            return res.status(400).json({ error: 'Invalid frame index' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Empty frame body' });
        }

        const format = session.format || 'png';
        try {
            if (format === 'rgba') {
                const expected = session.width * session.height * 4;
                if (req.body.length !== expected) {
                    return res.status(400).json({
                        error: `RGBA frame size mismatch: got ${req.body.length}, expected ${expected} (${session.width}x${session.height})`,
                    });
                }
            } else {
                // PNG magic bytes
                if (req.body.length < 8 || req.body[0] !== 0x89 || req.body[1] !== 0x50) {
                    return res.status(400).json({ error: 'Body is not a PNG image' });
                }
            }

            const name = frameFileName(index, format);
            fs.writeFileSync(path.join(session.dir, name), req.body);
            session.frames = Math.max(session.frames, index + 1);
            res.json({ ok: true, index, bytes: req.body.length, format });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to store frame' });
        }
    }
);

app.post('/api/export/session/:id/finalize', async (req, res) => {
    const session = getExportSession(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Unknown or expired export session' });
    }

    const fps = Math.max(1, Math.min(120, parseInt(req.body?.fps, 10) || 30));
    let frameCount = parseInt(req.body?.frameCount, 10);
    if (!Number.isFinite(frameCount) || frameCount < 1) {
        frameCount = session.frames;
    }
    if (frameCount < 1) {
        destroyExportSession(req.params.id);
        return res.status(400).json({ error: 'No frames in session' });
    }
    if (frameCount > FFMPEG_MAX_FRAMES) {
        destroyExportSession(req.params.id);
        return res.status(400).json({ error: `Too many frames (max ${FFMPEG_MAX_FRAMES})` });
    }

    const format = session.format || 'png';
    // Verify sequential frames exist
    for (let i = 0; i < frameCount; i++) {
        const p = path.join(session.dir, frameFileName(i, format));
        if (!fs.existsSync(p)) {
            destroyExportSession(req.params.id);
            return res.status(400).json({ error: `Missing frame ${i} on server` });
        }
    }

    const exportDir = session.dir;
    const width = session.width;
    const height = session.height;
    // Remove from map so reapers don't double-delete while encoding; we own cleanup now
    exportSessions.delete(req.params.id);

    try {
        exportLog(
            `Finalize ${req.params.id}: ${frameCount} frames @ ${fps}fps (${format})`
        );
        const outPath =
            format === 'rgba'
                ? await encodeWebmFromRgbaDir(exportDir, frameCount, fps, width, height)
                : await encodeWebmFromPngDir(exportDir, frameCount, fps);

        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
            throw new Error('ffmpeg produced an empty output file');
        }

        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Content-Disposition', 'attachment; filename="export.webm"');
        const stream = fs.createReadStream(outPath);
        const cleanup = () => rmDirSafe(exportDir);
        stream.on('close', cleanup);
        stream.on('error', (err) => {
            exportLogError(`Export stream failed: ${err.message}`);
            cleanup();
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.end();
        });
        res.on('close', () => {
            if (!res.writableEnded) cleanup();
        });
        stream.pipe(res);
    } catch (err) {
        exportLogError(`WebM finalize failed: ${err.message}`);
        rmDirSafe(exportDir);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Export failed' });
        }
    }
});

app.delete('/api/export/session/:id', (req, res) => {
    destroyExportSession(req.params.id);
    res.json({ ok: true });
});

// Legacy bulk upload (kept for compatibility; prefer streaming session API)
const exportUpload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => cb(null, req.exportDir),
        filename: (_req, file, cb) => {
            const base = path
                .basename(file.originalname || 'frame.png')
                .replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, base || 'frame.png');
        },
    }),
    limits: {
        files: FFMPEG_MAX_FRAMES,
        fileSize: 40 * 1024 * 1024,
        fieldSize: 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'image/png' || /\.png$/i.test(file.originalname || '')) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG frames are accepted'));
        }
    },
});

app.post(
    '/api/export/webm',
    (req, res, next) => {
        try {
            req.exportDir = mkExportTemp(APP_DIR, 'as-export-').dir;
            next();
        } catch (err) {
            res.status(500).json({ error: `Failed to create temp dir: ${err.message}` });
        }
    },
    (req, res, next) => {
        exportUpload.array('frames', FFMPEG_MAX_FRAMES)(req, res, (err) => {
            if (err) {
                rmDirSafe(req.exportDir);
                return res.status(400).json({ error: err.message || 'Upload failed' });
            }
            next();
        });
    },
    async (req, res) => {
        const exportDir = req.exportDir;
        try {
            const probe = await probeFfmpegOrEnsure();
            if (!probe.available) {
                rmDirSafe(exportDir);
                return res.status(503).json({
                    error: 'ffmpeg not found.',
                    path: probe.path,
                });
            }
            const files = req.files || [];
            if (files.length === 0) {
                rmDirSafe(exportDir);
                return res.status(400).json({ error: 'No frames uploaded' });
            }
            const fps = Math.max(1, Math.min(120, parseInt(req.body.fps, 10) || 30));
            const sorted = [...files].sort((a, b) =>
                String(a.originalname || a.filename).localeCompare(
                    String(b.originalname || b.filename),
                    undefined,
                    { numeric: true }
                )
            );
            for (let i = 0; i < sorted.length; i++) {
                const target = path.join(exportDir, `frame_${String(i).padStart(5, '0')}.png`);
                const current = path.join(exportDir, sorted[i].filename);
                if (path.resolve(current) !== path.resolve(target)) {
                    if (fs.existsSync(target)) fs.unlinkSync(target);
                    fs.renameSync(current, target);
                }
            }
            const outPath = await encodeWebmFromDir(exportDir, sorted.length, fps);
            if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
                throw new Error('ffmpeg produced an empty output file');
            }
            res.setHeader('Content-Type', 'video/webm');
            res.setHeader('Content-Disposition', 'attachment; filename="export.webm"');
            const stream = fs.createReadStream(outPath);
            stream.on('close', () => rmDirSafe(exportDir));
            stream.on('error', () => rmDirSafe(exportDir));
            res.on('close', () => {
                if (!res.writableEnded) rmDirSafe(exportDir);
            });
            stream.pipe(res);
        } catch (err) {
            console.error('  [ERROR] WebM export failed:', err.message);
            rmDirSafe(exportDir);
            if (!res.headersSent) res.status(500).json({ error: err.message || 'Export failed' });
        }
    }
);

// SPA fallback (Angular client routes)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (!staticRoot) {
        return res
            .status(404)
            .send(
                'UI not found. Build the client (npm run build --prefix client) or use a release package. ' +
                    'Legacy vanilla UI is under legacy/public/ (reference only).'
            );
    }
    const indexPath = path.join(staticRoot, 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.status(404).send('UI not found. Build the client (npm run build) or use a release package.');
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log('');
    console.log('  ⚔️  AS Adventurer — VTuber Creation Pipeline');
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`  Static root: ${staticRoot || '(none — build client/dist or use www/)'}`);

    // Auto-download / upgrade managed ffmpeg (not bundled in releases).
    ensureFfmpegReady({ quiet: false })
        .then((result) => {
            if (result.path) {
                const ver =
                    result.version ||
                    probeVersionLine(result.path) ||
                    '';
                const tag = result.releaseTag ? ` [${result.releaseTag}]` : '';
                console.log(`  ffmpeg: ready (${result.source}) ${result.path}${tag}`);
                if (ver) console.log(`           ${ver}`);
            } else {
                console.log('  ffmpeg: NOT FOUND — transparent WebM export unavailable');
                console.log('           First launch downloads a platform build (needs network once).');
                console.log('           Or set FFMPEG_PATH / place bin/ffmpeg next to the app.');
                if (!process.pkg) {
                    console.log('           Dev: npm run ensure-ffmpeg');
                }
            }
            console.log('  Press Ctrl+C to stop');
            console.log('');
        })
        .catch((err) => {
            console.log('  ffmpeg: ensure failed —', err.message);
            console.log('  Press Ctrl+C to stop');
            console.log('');
        });

    // Auto-open browser (skip in dev dual-stack / Flatpak)
    if (process.env.SKIP_BROWSER === '1') return;
    const url = `http://localhost:${PORT}`;
    const start =
        process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${start} ${url}`);
});
