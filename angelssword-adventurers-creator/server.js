/**
 * ⚔️ AS Adventurer — Local Server + API Proxy
 * Angel's Sword Studios
 * 
 * Serves static files from public/ and proxies API requests
 * to OpenAI and Google Gemini to avoid CORS issues and protect API keys.
 */

const express = require('express');
// node-fetch v2 — kept for multipart FormData (OpenAI image edits).
// Large JSON bodies (xAI image data-URIs) use Node's native fetch / undici instead;
// node-fetch has been observed to throw TLS "bad record mac" on multi-MB POSTs.
const nodeFetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');
const path = require('path');
const { exec } = require('child_process');

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
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // X-API-Key is used for Gemini Interactions (image + video)
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Static files
// Detect pkg-compiled exe vs normal Node.js
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

app.use(express.static(path.join(APP_DIR, 'public')));

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

// --- Server Start ---
app.listen(PORT, () => {
    console.log('');
    console.log('  ⚔️  AS Adventurer — VTuber Creation Pipeline');
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop');
    console.log('');

    // Auto-open browser (skip in dev dual-stack)
    if (process.env.SKIP_BROWSER === '1') return;
    const url = `http://localhost:${PORT}`;
    const start = process.platform === 'win32' ? 'start' :
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${start} ${url}`);
});
