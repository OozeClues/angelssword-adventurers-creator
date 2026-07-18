/**
 * Local ComfyUI integration: discovery, templates, workflow conversion, generation.
 * Used by server.js as a same-origin proxy (browser cannot scan LAN / hit Comfy CORS).
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');
const crypto = require('crypto');
const FormData = require('form-data');
const nodeFetch = require('node-fetch');

// --- Active connection state (in-process; client also persists URL in localStorage) ---
const state = {
    baseUrl: null,
    lastScan: null,
    lastSystemStats: null,
    objectInfoCache: { baseUrl: null, data: null, at: 0 },
    templatesCache: { baseUrl: null, data: null, at: 0 },
};

const OBJECT_INFO_TTL_MS = 5 * 60 * 1000;
const TEMPLATES_TTL_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 800;
const GENERATE_POLL_MS = 1500;
const GENERATE_POLL_MS_SLOW = 4000; // while model load / long gaps — don't hammer Comfy
/** Absolute ceiling for one generate (LTX + Gemma cold load can exceed 15–20 min). */
const GENERATE_MAX_WAIT_MS = 60 * 60 * 1000; // 60 minutes
/** Image jobs are usually shorter; still allow long cold loads. */
const GENERATE_MAX_WAIT_IMAGE_MS = 30 * 60 * 1000;
/**
 * Only abort early if Comfy is *idle* (nothing running/pending) and history
 * has no outputs for this long — not "no UI progress", which is normal during
 * multi‑GB model / VAE allocate with no progress events.
 */
const GENERATE_IDLE_GRACE_MS = 10 * 60 * 1000;

/** Serialize generates per Comfy host so we don't stack LTX-sized jobs (VRAM thrash / allocate@0%). */
const generateLocks = new Map(); // baseUrl -> Promise chain

// ---------------------------------------------------------------------------
// SSRF / URL safety
// ---------------------------------------------------------------------------

function isPrivateOrLocalIp(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    // IPv4
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = [+m[1], +m[2], +m[3], +m[4]];
        if (a.some((n) => n > 255)) return false;
        if (a[0] === 10) return true;
        if (a[0] === 127) return true;
        if (a[0] === 192 && a[1] === 168) return true;
        if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
        if (a[0] === 169 && a[1] === 254) return false; // link-local / cloud metadata — block
        if (a[0] === 0) return false;
        return false;
    }
    // Block obvious public hostnames; only bare IPs / localhost allowed
    return false;
}

/** Normalize and validate a ComfyUI base URL (http(s) to private/local hosts only). */
function normalizeBaseUrl(raw) {
    if (!raw || typeof raw !== 'string') throw new Error('Base URL is required');
    let s = raw.trim();
    if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
    let u;
    try {
        u = new URL(s);
    } catch {
        throw new Error('Invalid base URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Only http(s) URLs are allowed');
    }
    if (u.username || u.password) throw new Error('Credentials in URL are not supported');
    if (!isPrivateOrLocalIp(u.hostname)) {
        throw new Error(
            'ComfyUI URL must point to localhost or a private LAN address (e.g. 192.168.x.x)'
        );
    }
    if (u.hostname === '169.254.169.254') throw new Error('Blocked address');
    // Drop path/query; keep host + port
    const portPart = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${portPart}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers (local Comfy only — short timeouts for probes)
// ---------------------------------------------------------------------------

function fetchJson(url, options = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: timeoutMs,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const text = buf.toString('utf8');
                    let body = text;
                    const ct = res.headers['content-type'] || '';
                    if (ct.includes('json') || text.startsWith('{') || text.startsWith('[')) {
                        try {
                            body = JSON.parse(text);
                        } catch {
                            /* keep text */
                        }
                    }
                    resolve({ status: res.statusCode || 0, headers: res.headers, body, buffer: buf });
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        if (options.body) {
            if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
                req.write(options.body);
            } else if (options.body.pipe) {
                options.body.pipe(req);
                return;
            }
        }
        req.end();
    });
}

async function comfyGet(baseUrl, path, timeoutMs = 30000) {
    const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    return fetchJson(url, { method: 'GET' }, timeoutMs);
}

async function comfyPostJson(baseUrl, path, data, timeoutMs = 120000) {
    const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const body = JSON.stringify(data);
    return fetchJson(
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            body,
        },
        timeoutMs
    );
}

async function probeComfy(baseUrl) {
    try {
        const normalized = normalizeBaseUrl(baseUrl);
        const res = await comfyGet(normalized, '/system_stats', PROBE_TIMEOUT_MS);
        if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
            // Comfy returns { system: {...}, devices: [...] }
            if (res.body.system || res.body.devices || res.body.comfyui_version != null) {
                return { ok: true, baseUrl: normalized, systemStats: res.body };
            }
        }
        // Some older builds might still return 200 with different shape — accept object body
        if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
            return { ok: true, baseUrl: normalized, systemStats: res.body };
        }
        return { ok: false, baseUrl: normalized, error: `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, baseUrl: String(baseUrl), error: err.message || 'unreachable' };
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listLocalIpv4Bases() {
    const nets = os.networkInterfaces();
    const bases = [];
    for (const entries of Object.values(nets)) {
        if (!entries) continue;
        for (const ent of entries) {
            if (ent.family !== 'IPv4' && ent.family !== 4) continue;
            if (ent.internal) continue;
            const parts = ent.address.split('.').map(Number);
            if (parts.length !== 4) continue;
            // Skip link-local
            if (parts[0] === 169 && parts[1] === 254) continue;
            bases.push({ base: `${parts[0]}.${parts[1]}.${parts[2]}`, self: ent.address });
        }
    }
    // Dedupe by base
    const seen = new Set();
    return bases.filter((b) => {
        if (seen.has(b.base)) return false;
        seen.add(b.base);
        return true;
    });
}

async function mapPool(items, concurrency, fn) {
    const results = new Array(items.length);
    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await fn(items[idx], idx);
        }
    }
    const n = Math.min(concurrency, items.length || 1);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

/**
 * Scan localhost (and optionally LAN /24 on 8188) for ComfyUI.
 * @param {{ lan?: boolean }} opts
 */
async function scanForComfy(opts = {}) {
    const lan = opts.lan !== false;
    const candidates = [];

    // Localhost common ports
    for (const port of [8188, 8189, 8000, 8187]) {
        candidates.push(`http://127.0.0.1:${port}`);
        candidates.push(`http://localhost:${port}`);
    }

    if (lan) {
        const nets = listLocalIpv4Bases();
        for (const { base, self } of nets.slice(0, 2)) {
            for (let host = 1; host <= 254; host++) {
                const ip = `${base}.${host}`;
                if (ip === self) continue;
                candidates.push(`http://${ip}:8188`);
            }
        }
    }

    // Dedupe
    const uniq = [...new Set(candidates)];
    const found = [];
    await mapPool(uniq, 40, async (url) => {
        const r = await probeComfy(url);
        if (r.ok) {
            found.push({
                baseUrl: r.baseUrl,
                systemStats: r.systemStats,
                local: /127\.0\.0\.1|localhost/i.test(r.baseUrl),
            });
        }
    });

    // Prefer localhost first
    found.sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));

    // Dedupe by host:port (127.0.0.1 vs localhost)
    const seenHosts = new Set();
    const uniqueFound = [];
    for (const f of found) {
        try {
            const u = new URL(f.baseUrl);
            const key = `${u.hostname === 'localhost' ? '127.0.0.1' : u.hostname}:${u.port || '80'}`;
            if (seenHosts.has(key)) continue;
            seenHosts.add(key);
            uniqueFound.push(f);
        } catch {
            uniqueFound.push(f);
        }
    }

    state.lastScan = {
        at: Date.now(),
        lan,
        count: uniqueFound.length,
        candidates: uniqueFound.map((f) => f.baseUrl),
    };

    return uniqueFound;
}

async function connectComfy(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    const r = await probeComfy(normalized);
    if (!r.ok) {
        throw new Error(r.error || `Could not reach ComfyUI at ${normalized}`);
    }
    state.baseUrl = normalized;
    state.lastSystemStats = r.systemStats;
    state.objectInfoCache = { baseUrl: null, data: null, at: 0 };
    state.templatesCache = { baseUrl: null, data: null, at: 0 };
    return { baseUrl: normalized, systemStats: r.systemStats };
}

function getStatus() {
    return {
        connected: !!state.baseUrl,
        baseUrl: state.baseUrl,
        systemStats: state.lastSystemStats,
        lastScan: state.lastScan,
    };
}

function resolveBase(reqBase) {
    if (reqBase) return normalizeBaseUrl(reqBase);
    if (state.baseUrl) return state.baseUrl;
    throw new Error('No ComfyUI instance connected. Scan or enter a URL in Settings.');
}

// ---------------------------------------------------------------------------
// object_info + templates
// ---------------------------------------------------------------------------

async function getObjectInfo(baseUrl) {
    const base = resolveBase(baseUrl);
    if (
        state.objectInfoCache.baseUrl === base &&
        state.objectInfoCache.data &&
        Date.now() - state.objectInfoCache.at < OBJECT_INFO_TTL_MS
    ) {
        return state.objectInfoCache.data;
    }
    const res = await comfyGet(base, '/object_info', 60000);
    if (res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') {
        throw new Error(`Failed to load ComfyUI object_info (HTTP ${res.status})`);
    }
    state.objectInfoCache = { baseUrl: base, data: res.body, at: Date.now() };
    return res.body;
}

/**
 * Fetch template index from a running ComfyUI instance.
 * Tries several known paths used by frontend / workflow_templates package.
 */
async function fetchTemplateIndex(baseUrl) {
    const base = resolveBase(baseUrl);
    if (
        state.templatesCache.baseUrl === base &&
        state.templatesCache.data &&
        Date.now() - state.templatesCache.at < TEMPLATES_TTL_MS
    ) {
        return state.templatesCache.data;
    }

    const paths = [
        '/templates/index.json',
        '/api/workflow_templates',
        '/workflow_templates',
    ];

    let index = null;
    let moduleMap = null;

    for (const p of paths) {
        try {
            const res = await comfyGet(base, p, 10000);
            if (res.status < 200 || res.status >= 300) continue;
            if (Array.isArray(res.body)) {
                index = res.body;
                break;
            }
            if (res.body && typeof res.body === 'object' && !Array.isArray(res.body)) {
                // workflow_templates map: { moduleName: [names...] }
                const keys = Object.keys(res.body);
                if (keys.length && Array.isArray(res.body[keys[0]])) {
                    moduleMap = res.body;
                    continue;
                }
            }
        } catch {
            /* try next */
        }
    }

    // If we only got module map, synthesize a minimal catalog
    if (!index && moduleMap) {
        index = [];
        for (const [moduleName, names] of Object.entries(moduleMap)) {
            const list = Array.isArray(names) ? names : [];
            const image = [];
            const video = [];
            for (const name of list) {
                const n = String(name);
                const entry = {
                    name: n.replace(/\.json$/i, ''),
                    title: n.replace(/\.json$/i, '').replace(/_/g, ' '),
                    mediaType: /video/i.test(n) ? 'video' : 'image',
                    openSource: true,
                    moduleName,
                };
                if (/video/i.test(n)) video.push(entry);
                else image.push(entry);
            }
            if (image.length) {
                index.push({
                    moduleName,
                    title: moduleName === 'default' ? 'Image' : moduleName,
                    type: 'image',
                    templates: image,
                });
            }
            if (video.length) {
                index.push({
                    moduleName,
                    title: moduleName === 'default' ? 'Video' : `${moduleName} (video)`,
                    type: 'video',
                    templates: video,
                });
            }
        }
    }

    if (!index) {
        index = [];
    }

    state.templatesCache = { baseUrl: base, data: index, at: Date.now() };
    return index;
}

function flattenTemplates(index, media) {
    const want = media === 'video' ? 'video' : 'image';
    const out = [];
    for (const cat of index || []) {
        const catType = String(cat.type || cat.mediaType || '').toLowerCase();
        // Include category if type matches, or if type is empty (unknown)
        const catMatch =
            catType === want ||
            catType === '' ||
            (want === 'image' && catType === 'image') ||
            (want === 'video' && catType === 'video');
        if (!catMatch && catType && catType !== want) continue;

        for (const t of cat.templates || []) {
            const tags = (t.tags || []).map(String);
            const name = String(t.name || '');
            const title = String(t.title || name);
            // Infer media from category type, tags, or name
            let mediaType = catType === 'video' || catType === 'image' ? catType : null;
            if (!mediaType) {
                if (tags.some((x) => /video/i.test(x)) || /video/i.test(name)) mediaType = 'video';
                else mediaType = 'image';
            }
            if (mediaType !== want) continue;

            const openSource = t.openSource !== false && !tags.some((x) => /^api$/i.test(x));
            // Cloud / hosted API workflows (need keys inside ComfyUI)
            const isApi =
                t.openSource === false ||
                tags.some((x) => /^(api|cloud)$/i.test(String(x))) ||
                tags.some((x) => /api[-_ ]?template|cloud/i.test(String(x))) ||
                /^api[_-]/i.test(name) ||
                /_api$/i.test(name) ||
                /\b(openai|gemini|flux[-_]?api|ideogram|stability[-_]?api)\b/i.test(name);

            out.push({
                id: name,
                name,
                title,
                description: t.description || '',
                tags,
                models: t.models || [],
                openSource: openSource && !isApi,
                isApi,
                moduleName: cat.moduleName || 'default',
                category: cat.title || '',
                mediaType: want,
                io: t.io || null,
                tutorialUrl: t.tutorialUrl || null,
            });
        }
    }

    // Sort: local/open-source first, then title
    out.sort((a, b) => {
        if (a.isApi !== b.isApi) return a.isApi ? 1 : -1;
        return a.title.localeCompare(b.title);
    });
    return out;
}

async function listTemplates(baseUrl, media = 'image', { includeApi = false } = {}) {
    const index = await fetchTemplateIndex(baseUrl);
    let list = flattenTemplates(index, media);
    if (!includeApi) list = list.filter((t) => !t.isApi);
    return list;
}

async function fetchTemplateWorkflow(baseUrl, templateName) {
    const base = resolveBase(baseUrl);
    const name = String(templateName || '').replace(/\.json$/i, '');
    if (!name || /[^a-zA-Z0-9_\-.]/.test(name)) {
        throw new Error('Invalid template name');
    }

    const paths = [
        `/templates/${name}.json`,
        `/api/templates/${name}.json`,
        `/workflow_templates/${name}.json`,
    ];

    for (const p of paths) {
        try {
            const res = await comfyGet(base, p, 30000);
            if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
                return res.body;
            }
        } catch {
            /* next */
        }
    }
    throw new Error(`Template "${name}" not found on ComfyUI instance`);
}

// ---------------------------------------------------------------------------
// Execution history (reuse past ComfyUI runs as workflow sources)
// ---------------------------------------------------------------------------

const VIDEO_CLASS_HINTS = /video|vhs_|animate|svd|wan|ltxv|hunyuan|cogvideo|mochi|i2v|t2v/i;
const HISTORY_ID_PREFIX = 'history:';

function extractApiWorkflowFromHistoryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    // Standard: prompt = [number, prompt_id, api_workflow, extra_data, output_nodes]
    const p = entry.prompt;
    if (Array.isArray(p) && p.length >= 3 && p[2] && typeof p[2] === 'object' && !Array.isArray(p[2])) {
        return p[2];
    }
    // Some builds store prompt as object
    if (p && typeof p === 'object' && !Array.isArray(p)) {
        if (isApiFormatWorkflow(p)) return p;
        if (p.prompt && isApiFormatWorkflow(p.prompt)) return p.prompt;
    }
    // Fallback: extra_data.extra_pnginfo.workflow (UI format — caller may convert)
    const extra = entry.extra_data || (Array.isArray(p) && p[3]) || {};
    const png = extra.extra_pnginfo || extra;
    if (png && png.workflow && typeof png.workflow === 'object') {
        return png.workflow;
    }
    return null;
}

function classifyHistoryMedia(entry, apiWf) {
    const outputs = entry.outputs || {};
    let hasVideo = false;
    let hasImage = false;
    for (const nodeOut of Object.values(outputs)) {
        if (!nodeOut || typeof nodeOut !== 'object') continue;
        if (Array.isArray(nodeOut.gifs) && nodeOut.gifs.length) hasVideo = true;
        if (Array.isArray(nodeOut.videos) && nodeOut.videos.length) hasVideo = true;
        if (Array.isArray(nodeOut.animated) && nodeOut.animated.length) hasVideo = true;
        if (Array.isArray(nodeOut.images) && nodeOut.images.length) {
            // animated webp sometimes listed under images
            const names = nodeOut.images.map((i) => String((i && i.filename) || i || '').toLowerCase());
            if (names.some((n) => n.endsWith('.webm') || n.endsWith('.mp4') || n.endsWith('.gif'))) {
                hasVideo = true;
            } else {
                hasImage = true;
            }
        }
    }

    if (apiWf && typeof apiWf === 'object') {
        for (const node of Object.values(apiWf)) {
            const ct = (node && node.class_type) || '';
            if (VIDEO_CLASS_HINTS.test(ct) || SAVE_VIDEO_TYPES.has(ct)) hasVideo = true;
            if (SAVE_IMAGE_TYPES.has(ct)) hasImage = true;
        }
    }

    if (hasVideo && !hasImage) return 'video';
    if (hasVideo && hasImage) return 'both';
    if (hasImage) return 'image';
    // Unknown — allow both selectors
    return 'both';
}

function summarizeHistoryWorkflow(apiWf) {
    if (!apiWf || typeof apiWf !== 'object') return { nodeCount: 0, classes: [], promptPreview: '' };
    const classes = [];
    let promptPreview = '';
    for (const node of Object.values(apiWf)) {
        if (!node || !node.class_type) continue;
        classes.push(node.class_type);
        if (!promptPreview && node.inputs && typeof node.inputs.text === 'string' && node.inputs.text.trim()) {
            const t = node.inputs.text.trim().replace(/\s+/g, ' ');
            // Skip negative-looking titles if present
            const title = (node._meta && node._meta.title) || '';
            if (!/negative/i.test(title)) {
                promptPreview = t.slice(0, 80);
            }
        }
    }
    // Unique class summary (keep order of first appearance, cap)
    const seen = new Set();
    const unique = [];
    for (const c of classes) {
        if (seen.has(c)) continue;
        seen.add(c);
        unique.push(c);
        if (unique.length >= 6) break;
    }
    return { nodeCount: classes.length, classes: unique, promptPreview };
}

function historyTimestamp(entry) {
    // Prefer status messages with execution times; fall back to nothing
    const status = entry.status || {};
    if (status.messages && Array.isArray(status.messages)) {
        for (const m of status.messages) {
            // ["execution_start", { prompt_id, timestamp }]
            if (Array.isArray(m) && m[1] && typeof m[1].timestamp === 'number') {
                return m[1].timestamp;
            }
        }
    }
    return null;
}

/**
 * List recent history entries that can be re-run as workflows.
 * @returns {Array<{ id, promptId, title, description, mediaType, media, at, nodeCount, classes }>}
 */
async function listHistory(baseUrl, { media = 'image', maxItems = 40 } = {}) {
    const base = resolveBase(baseUrl);
    const want = media === 'video' ? 'video' : 'image';
    let res;
    try {
        res = await comfyGet(base, `/history?max_items=${Math.min(100, Math.max(1, maxItems))}`, 30000);
    } catch {
        res = await comfyGet(base, '/history', 30000);
    }
    if (res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') {
        throw new Error(`Failed to load ComfyUI history (HTTP ${res.status || 0})`);
    }

    const body = res.body;
    // Cloud-ish shape: { history: [...] } — support both
    let entries;
    if (Array.isArray(body.history)) {
        entries = body.history.map((h) => [h.prompt_id || h.id, h]);
    } else {
        entries = Object.entries(body);
    }

    const out = [];
    for (const [promptId, entry] of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const apiWf = extractApiWorkflowFromHistoryEntry(entry);
        if (!apiWf) continue;

        const mediaKind = classifyHistoryMedia(entry, isApiFormatWorkflow(apiWf) ? apiWf : null);
        if (mediaKind !== 'both' && mediaKind !== want) continue;

        const summary = summarizeHistoryWorkflow(isApiFormatWorkflow(apiWf) ? apiWf : null);
        const ts = historyTimestamp(entry);
        const shortId = String(promptId).slice(0, 8);
        const when = ts
            ? new Date(ts * (ts < 1e12 ? 1000 : 1)).toLocaleString()
            : '';
        const titleParts = ['History', shortId];
        if (when) titleParts.push(when);
        const title = titleParts.join(' · ');

        const descBits = [];
        if (summary.promptPreview) descBits.push(`“${summary.promptPreview}${summary.promptPreview.length >= 80 ? '…' : ''}”`);
        if (summary.nodeCount) descBits.push(`${summary.nodeCount} nodes`);
        if (summary.classes.length) descBits.push(summary.classes.slice(0, 4).join(', '));

        out.push({
            id: `${HISTORY_ID_PREFIX}${promptId}`,
            promptId: String(promptId),
            title,
            description: descBits.join(' · '),
            mediaType: want,
            media: mediaKind,
            at: ts,
            nodeCount: summary.nodeCount,
            classes: summary.classes,
            source: 'history',
        });
    }

    // Newest first when timestamps exist
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out.slice(0, maxItems);
}

async function fetchHistoryWorkflow(baseUrl, promptId) {
    const base = resolveBase(baseUrl);
    const id = String(promptId || '').replace(/^history:/, '');
    if (!id || /[^a-zA-Z0-9_\-]/.test(id)) {
        throw new Error('Invalid history prompt id');
    }
    const res = await comfyGet(base, `/history/${encodeURIComponent(id)}`, 30000);
    if (res.status < 200 || res.status >= 300 || !res.body || typeof res.body !== 'object') {
        throw new Error(`History entry ${id} not found (HTTP ${res.status || 0})`);
    }
    const entry = res.body[id] || res.body;
    const wf = extractApiWorkflowFromHistoryEntry(entry);
    if (!wf) {
        throw new Error(
            `History entry ${id} has no reusable workflow. Run the graph once in ComfyUI, then refresh.`
        );
    }
    return wf;
}

/**
 * Resolve a templateId that may be a catalog template or history:<prompt_id>.
 */
async function resolveWorkflowSource(baseUrl, templateId) {
    const id = String(templateId || '');
    if (id.startsWith(HISTORY_ID_PREFIX)) {
        return fetchHistoryWorkflow(baseUrl, id.slice(HISTORY_ID_PREFIX.length));
    }
    return fetchTemplateWorkflow(baseUrl, id);
}

// ---------------------------------------------------------------------------
// Workflow format detection + UI → API conversion
// ---------------------------------------------------------------------------

/** UI-only / virtual nodes — never appear in API prompts. */
const VIRTUAL_NODE_TYPES = new Set([
    'PrimitiveNode',
    'Note',
    'MarkdownNote',
    'Reroute',
    'Reroute (rgthree)',
    'Fast Groups Bypasser (rgthree)',
    'Bookmark (rgthree)',
    'Label (rgthree)',
]);

function isVirtualNodeType(type) {
    if (!type) return true;
    if (VIRTUAL_NODE_TYPES.has(type)) return true;
    // Grouped / frontend helpers
    if (/^Note/i.test(type)) return true;
    if (/Reroute/i.test(type)) return true;
    if (/Primitive/i.test(type)) return true;
    return false;
}

function isApiFormatWorkflow(wf) {
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return false;
    // API format: numeric string keys with class_type
    const keys = Object.keys(wf).filter(
        (k) => k !== 'extra' && k !== 'version' && k !== 'workflow' && k !== 'prompt' && k !== 'extra_data'
    );
    if (!keys.length) return false;
    let apiLike = 0;
    for (const k of keys) {
        const n = wf[k];
        if (n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs) apiLike++;
    }
    return apiLike >= Math.max(1, keys.length * 0.5);
}

function isUiFormatWorkflow(wf) {
    if (!wf || typeof wf !== 'object') return false;
    return Array.isArray(wf.nodes);
}

/**
 * Normalize various Comfy export shapes into either UI workflow or API prompt dict.
 * Handles: plain API prompt, plain UI save, { prompt }, { workflow }, { prompt, workflow }.
 */
function normalizeWorkflowRaw(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Workflow JSON must be an object');
    }
    // Prefer embedded API prompt when present (matches what Comfy actually ran)
    if (raw.prompt && typeof raw.prompt === 'object' && !Array.isArray(raw.prompt)) {
        if (isApiFormatWorkflow(raw.prompt)) return { kind: 'api', workflow: raw.prompt };
    }
    if (isApiFormatWorkflow(raw)) return { kind: 'api', workflow: raw };
    if (raw.workflow && typeof raw.workflow === 'object') {
        if (isApiFormatWorkflow(raw.workflow)) return { kind: 'api', workflow: raw.workflow };
        if (isUiFormatWorkflow(raw.workflow)) return { kind: 'ui', workflow: raw.workflow };
    }
    if (isUiFormatWorkflow(raw)) return { kind: 'ui', workflow: raw };
    throw new Error(
        'Unrecognized workflow JSON. Export from ComfyUI via Save or Save (API Format).'
    );
}

/**
 * Collect subgraph definitions from a workflow (root + any nested defs).
 * @returns {Map<string, object>} id → subgraph def
 */
function collectSubgraphDefs(workflow) {
    const defs = new Map();
    function addFrom(container) {
        if (!container || typeof container !== 'object') return;
        const list =
            (container.definitions && container.definitions.subgraphs) ||
            container.subgraphs ||
            [];
        for (const sg of list) {
            if (!sg || sg.id == null) continue;
            defs.set(String(sg.id), sg);
            // Nested definitions inside a subgraph
            addFrom(sg);
        }
    }
    addFrom(workflow);
    return defs;
}

function cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Expand subgraph instances into a flat UI workflow (nodes + links).
 * Internal node ids become `"parentId:innerId"` (or nested `"a:b:c"`).
 * Boundary I/O (-10 input / -20 output nodes) is rewired to parent links.
 * After this, convertUiToApi can treat the graph as a normal flat workflow.
 */
function flattenSubgraphs(workflow) {
    if (!isUiFormatWorkflow(workflow)) return workflow;
    const defs = collectSubgraphDefs(workflow);
    if (!defs.size) return workflow;

    let nextLinkId = 1;
    for (const link of workflow.links || []) {
        const p = parseLinkEntry(link);
        if (p && typeof p.id === 'number' && p.id >= nextLinkId) nextLinkId = p.id + 1;
    }

    /**
     * @param {object[]} nodes
     * @param {any[]} links
     * @param {string} idPrefix  e.g. "" or "140:" or "10:20:"
     * @param {string} titlePrefix for model-picker labels
     */
    function flattenLevel(nodes, links, idPrefix, titlePrefix) {
        const outNodes = [];
        const outLinks = [];
        const parsedLinks = (links || []).map(parseLinkEntry).filter(Boolean);

        // Prefixed id helper
        const pid = (id) => {
            if (id == null) return id;
            // Boundary virtual nodes stay as-is until rewired (negative ids)
            if (typeof id === 'number' && id < 0) return id;
            return idPrefix ? `${idPrefix}${id}` : id;
        };

        // First pass: expand subgraph instances; keep regular nodes
        /** @type {Map<string|number, { inputTargets: Map<number, Array<{nodeId, slot}>>, outputSources: Map<number, {nodeId, slot}>, node: object }>} */
        const expansions = new Map();

        for (const node of nodes || []) {
            if (!node) continue;
            const typeKey = String(node.type || '');
            // Definition by type UUID, or inline node.subgraph (live canvas export)
            let def = defs.get(typeKey);
            if (!def && node.subgraph && typeof node.subgraph === 'object' && Array.isArray(node.subgraph.nodes)) {
                def = node.subgraph;
                if (def.id != null) defs.set(String(def.id), def);
            }

            if (!def) {
                // Regular node
                const n = cloneJson(node);
                n.id = pid(node.id);
                if (titlePrefix) {
                    const base = n.title || n.type || String(n.id);
                    n.title = `${titlePrefix} / ${base}`;
                }
                // Remap input.link ids — link ids stay unique via rebuild below
                outNodes.push(n);
                continue;
            }

            // --- Expand subgraph instance ---
            const instKey = node.id;
            const childPrefix = idPrefix ? `${idPrefix}${node.id}:` : `${node.id}:`;
            const childTitle = titlePrefix
                ? `${titlePrefix} / ${node.title || def.name || 'Subgraph'}`
                : node.title || def.name || 'Subgraph';

            // Recurse into subgraph body
            const inner = flattenLevel(def.nodes || [], def.links || [], childPrefix, childTitle);

            // Apply proxyWidgets from outer node onto expanded inner nodes
            applyProxyWidgets(node, def, inner.nodes, childPrefix);

            // Build boundary maps from inner links (still may use -10/-20 origins/targets)
            const inputTargets = new Map(); // slot -> [{nodeId, slot}]
            const outputSources = new Map(); // slot -> {nodeId, slot}

            // Re-scan def.links for boundary (using child-prefixed internal ids)
            for (const raw of def.links || []) {
                const L = parseLinkEntry(raw);
                if (!L) continue;
                if (L.origin_id === -10 || L.origin_id === def.inputNode?.id) {
                    const slot = L.origin_slot;
                    if (!inputTargets.has(slot)) inputTargets.set(slot, []);
                    inputTargets.get(slot).push({
                        nodeId: childPrefix + L.target_id,
                        slot: L.target_slot,
                    });
                }
                if (L.target_id === -20 || L.target_id === def.outputNode?.id) {
                    outputSources.set(L.target_slot, {
                        nodeId: childPrefix + L.origin_id,
                        slot: L.origin_slot,
                    });
                }
            }

            // Also from def.inputs/outputs linkIds if present
            if (Array.isArray(def.inputs)) {
                def.inputs.forEach((inp, idx) => {
                    // already covered via links with origin -10
                    void inp;
                    void idx;
                });
            }

            // Keep expanded inner nodes (filter any residual boundary ghosts)
            for (const n of inner.nodes) {
                if (n.id === -10 || n.id === -20) continue;
                outNodes.push(n);
            }

            // Keep internal links that don't touch boundary
            for (const L of inner.links || []) {
                const pl = parseLinkEntry(L);
                if (!pl) continue;
                if (pl.origin_id === -10 || pl.target_id === -20) continue;
                if (pl.origin_id === def.inputNode?.id || pl.target_id === def.outputNode?.id) continue;
                // Inner flatten already remapped ids on links
                outLinks.push(pl);
            }

            // Also re-emit internal non-boundary links from def if inner.links incomplete
            // (inner.links should be complete from recursive flatten)

            expansions.set(instKey, {
                inputTargets,
                outputSources,
                node,
                def,
            });
        }

        // Second pass: rebuild links for this level
        // Map original link id → new link records (may fan-out for multi-target inputs)
        for (const L of parsedLinks) {
            let originId = L.origin_id;
            let originSlot = L.origin_slot;
            let targetId = L.target_id;
            let targetSlot = L.target_slot;

            // If origin is a subgraph instance, rewrite to internal output source
            if (expansions.has(originId)) {
                const exp = expansions.get(originId);
                const src = exp.outputSources.get(originSlot);
                if (!src) continue; // dangling
                originId = src.nodeId;
                originSlot = src.slot;
            } else {
                originId = pid(originId);
            }

            // If target is a subgraph instance, fan-out to all internal input targets
            if (expansions.has(targetId)) {
                const exp = expansions.get(targetId);
                const targets = exp.inputTargets.get(targetSlot) || [];
                for (const t of targets) {
                    outLinks.push({
                        id: nextLinkId++,
                        origin_id: originId,
                        origin_slot: originSlot,
                        target_id: t.nodeId,
                        target_slot: t.slot,
                        type: L.type,
                    });
                }
                continue;
            }

            targetId = pid(targetId);
            outLinks.push({
                id: nextLinkId++,
                origin_id: originId,
                origin_slot: originSlot,
                target_id: targetId,
                target_slot: targetSlot,
                type: L.type,
            });
        }

        // Patch node.inputs[].link to match new link ids
        const linksByTarget = new Map(); // `${nodeId}:${slot}` -> linkId
        for (const L of outLinks) {
            linksByTarget.set(`${L.target_id}:${L.target_slot}`, L.id);
        }
        for (const n of outNodes) {
            if (!Array.isArray(n.inputs)) continue;
            n.inputs.forEach((inp, slotIdx) => {
                if (!inp) return;
                // Prefer named slot index from array position
                const key = `${n.id}:${slotIdx}`;
                if (linksByTarget.has(key)) {
                    inp.link = linksByTarget.get(key);
                }
            });
        }

        return { nodes: outNodes, links: outLinks };
    }

    const flat = flattenLevel(workflow.nodes || [], workflow.links || [], '', '');
    return {
        ...workflow,
        nodes: flat.nodes,
        links: flat.links.map((L) => [
            L.id,
            L.origin_id,
            L.origin_slot,
            L.target_id,
            L.target_slot,
            L.type,
        ]),
        // definitions no longer needed for conversion
        definitions: undefined,
    };
}

/**
 * Copy promoted widget values from the outer subgraph node onto expanded inner nodes.
 */
function applyProxyWidgets(outerNode, def, expandedNodes, childPrefix) {
    const proxy = (outerNode.properties && outerNode.properties.proxyWidgets) || [];
    const values = Array.isArray(outerNode.widgets_values) ? outerNode.widgets_values : [];
    if (!proxy.length || !values.length) return;

    const byOldId = new Map();
    for (const n of expandedNodes) {
        // childPrefix + oldId === n.id
        if (n && n.id != null) byOldId.set(String(n.id), n);
    }

    for (let i = 0; i < proxy.length; i++) {
        const entry = proxy[i];
        if (!Array.isArray(entry) || entry.length < 1) continue;
        const innerOldId = entry[0];
        const val = values[i];
        if (val === undefined) continue;
        const fullId = childPrefix + innerOldId;
        const inner = byOldId.get(String(fullId));
        if (!inner) continue;
        if (!Array.isArray(inner.widgets_values)) inner.widgets_values = [];
        // Most promoted widgets map to the primary value at index 0
        if (inner.widgets_values.length === 0) inner.widgets_values = [val];
        else inner.widgets_values[0] = val;
    }
}

/**
 * Human-readable message from ComfyUI error payloads (objects, not bare strings).
 */
function formatComfyError(body, fallback = 'ComfyUI request failed') {
    if (body == null) return fallback;
    if (typeof body === 'string') {
        const t = body.trim();
        return t || fallback;
    }
    if (typeof body !== 'object') return String(body);

    const parts = [];

    // Top-level { error: string | { message, type, details }, node_errors: {...} }
    const errField = body.error;
    if (typeof errField === 'string' && errField.trim()) {
        parts.push(errField.trim());
    } else if (errField && typeof errField === 'object') {
        if (errField.message) parts.push(String(errField.message));
        if (errField.type && errField.type !== errField.message) {
            parts.push(`(${errField.type})`);
        }
        if (errField.details) {
            const d =
                typeof errField.details === 'string'
                    ? errField.details
                    : JSON.stringify(errField.details);
            if (d && d !== '{}' && d !== '[]') parts.push(d);
        }
    }

    if (typeof body.message === 'string' && body.message.trim()) {
        if (!parts.some((p) => p.includes(body.message))) parts.push(body.message.trim());
    }

    const nodeErrors = body.node_errors;
    if (nodeErrors && typeof nodeErrors === 'object') {
        for (const [nodeId, ne] of Object.entries(nodeErrors)) {
            if (!ne || typeof ne !== 'object') continue;
            const classType = ne.class_type || '?';
            const errs = Array.isArray(ne.errors) ? ne.errors : [];
            if (!errs.length) {
                parts.push(`node ${nodeId} (${classType}): invalid`);
                continue;
            }
            for (const e of errs.slice(0, 4)) {
                if (typeof e === 'string') {
                    parts.push(`node ${nodeId} (${classType}): ${e}`);
                } else if (e && typeof e === 'object') {
                    const msg = e.message || e.details || e.type || JSON.stringify(e);
                    parts.push(`node ${nodeId} (${classType}): ${msg}`);
                }
            }
        }
    }

    // Exception-style { exception_message, exception_type, traceback }
    if (body.exception_message) parts.push(String(body.exception_message));
    if (body.exception_type) parts.push(`type: ${body.exception_type}`);

    const joined = parts.filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
    if (joined && joined !== '[object Object]') return joined.slice(0, 1200);

    // Last resort: compact JSON
    try {
        const s = JSON.stringify(body);
        if (s && s !== '{}' && s !== '[]') return s.slice(0, 800);
    } catch {
        /* ignore */
    }
    return fallback;
}

function parseLinkEntry(link) {
    if (Array.isArray(link) && link.length >= 5) {
        return {
            id: link[0],
            origin_id: link[1],
            origin_slot: link[2],
            target_id: link[3],
            target_slot: link[4],
            type: link[5],
        };
    }
    if (link && typeof link === 'object' && link.id != null) {
        return {
            id: link.id,
            origin_id: link.origin_id,
            origin_slot: link.origin_slot,
            target_id: link.target_id,
            target_slot: link.target_slot,
            type: link.type,
        };
    }
    return null;
}

function primitiveWidgetValue(node) {
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    if (!widgets.length) return null;
    // INT primitives often: [value, "fixed"|"randomize"|…]
    return widgets[0];
}

/**
 * Whether an object_info input spec is a "widget" type (not a pure connection type).
 * Connection types are uppercase tokens like MODEL, CLIP, LATENT, CONDITIONING, IMAGE, VAE, …
 */
function isWidgetSpec(spec) {
    if (!Array.isArray(spec) || !spec.length) return false;
    const t = spec[0];
    if (Array.isArray(t)) return true; // combo enum
    if (typeof t !== 'string') return false;
    const upper = t.toUpperCase();
    // Pure socket types (no widget)
    if (
        /^(MODEL|CLIP|VAE|CONDITIONING|LATENT|IMAGE|MASK|AUDIO|VIDEO|CONTROL_NET|STYLE_MODEL|CLIP_VISION|UPSCALE_MODEL|GLIGEN|NOISE|GUIDER|SAMPLER|SIGMAS|PHOTOMAKER|WEBCAM|MESH|VOXEL|LATENT_OPERATION|PIPE_LINE|PIPE_LINE_SDXL)$/i.test(
            t
        )
    ) {
        return false;
    }
    // COMBO is widget
    if (t === 'COMBO' || upper === 'COMBO') return true;
    // Primitive-ish
    if (/^(INT|FLOAT|STRING|BOOLEAN|NUMBER)$/i.test(t)) return true;
    // Everything else with options object is usually a widget
    return true;
}

/**
 * Convert ComfyUI UI/save workflow to API prompt format using object_info.
 * Handles PrimitiveNode / Reroute the way the Comfy frontend does (resolve to values / real nodes).
 * Expands subgraph instances first so loaders inside subgraphs appear as normal nodes.
 */
function convertUiToApi(workflow, objectInfo) {
    if (isApiFormatWorkflow(workflow)) return JSON.parse(JSON.stringify(workflow));
    if (!isUiFormatWorkflow(workflow)) {
        throw new Error('Workflow is neither UI format nor API format');
    }

    // Expand subgraphs → flat UI graph (node ids may be "parent:inner")
    const flat = flattenSubgraphs(workflow);
    const nodes = flat.nodes || [];
    const links = flat.links || [];
    const nodeById = new Map();
    for (const n of nodes) {
        if (n && n.id != null) nodeById.set(String(n.id), n);
    }

    const linkById = new Map();
    for (const link of links) {
        const parsed = parseLinkEntry(link);
        if (parsed) linkById.set(parsed.id, parsed);
    }

    /**
     * Follow a link to a non-virtual origin, or a constant value from a Primitive.
     * @returns {{ kind: 'link', id: string, slot: number } | { kind: 'value', value: unknown } | null}
     */
    function resolveOrigin(linkId, depth = 0) {
        if (linkId == null || depth > 32) return null;
        const link = linkById.get(linkId);
        if (!link) return null;
        const origin = nodeById.get(String(link.origin_id));
        if (!origin) return null;

        // Skip never-execute origins
        if (origin.mode === 2) return null;

        if (origin.type === 'Reroute' || /Reroute/i.test(origin.type || '')) {
            const rin = Array.isArray(origin.inputs) ? origin.inputs[0] : null;
            if (rin && rin.link != null) return resolveOrigin(rin.link, depth + 1);
            return null;
        }

        if (isVirtualNodeType(origin.type) || origin.type === 'PrimitiveNode') {
            return { kind: 'value', value: primitiveWidgetValue(origin) };
        }

        return {
            kind: 'link',
            id: String(origin.id),
            slot: link.origin_slot,
        };
    }

    const prompt = {};
    for (const node of nodes) {
        if (!node) continue;
        // mode 2 = never
        if (node.mode === 2) continue;
        const classType = node.type;
        if (!classType || isVirtualNodeType(classType)) continue;
        // Bypass (4): still include — Comfy may pass-through; safer to keep for now

        const id = String(node.id);
        const info = objectInfo && objectInfo[classType];
        const inputs = {};
        const nodeInputs = Array.isArray(node.inputs) ? node.inputs : [];
        const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : [];

        // Linked sockets first (may resolve to primitive constants)
        const linkedNames = new Set();
        for (const inp of nodeInputs) {
            if (!inp || !inp.name) continue;
            if (inp.link == null) continue;
            const resolved = resolveOrigin(inp.link);
            if (!resolved) continue;
            if (resolved.kind === 'value') {
                // Primitive (or similar) — constant into this input
                if (resolved.value !== undefined && resolved.value !== null) {
                    inputs[inp.name] = resolved.value;
                }
                linkedNames.add(inp.name);
            } else {
                inputs[inp.name] = [resolved.id, resolved.slot];
                linkedNames.add(inp.name);
            }
        }

        // Widget values for remaining inputs (skip ones already set by links)
        if (info && info.input) {
            const order = [];
            for (const section of ['required', 'optional']) {
                const block = info.input[section] || {};
                for (const [name, spec] of Object.entries(block)) {
                    // Only consume widgets_values for widget-backed inputs
                    if (!isWidgetSpec(spec)) continue;
                    order.push({ name, spec });
                }
            }

            let wi = 0;
            for (const { name, spec } of order) {
                if (wi >= widgets.length) break;

                // Even if linked, widgets_values still contains a slot for this widget —
                // advance the index but do not overwrite a resolved link/value.
                const already = inputs[name] !== undefined;
                const typeName = Array.isArray(spec) ? spec[0] : null;
                let val = widgets[wi++];

                // control_after_generate companion for seed-like INT widgets
                if (
                    (typeName === 'INT' || typeName === 'FLOAT') &&
                    spec[1] &&
                    (spec[1].control_after_generate ||
                        (spec[1].tooltip && /seed/i.test(String(spec[1].tooltip || '')))) &&
                    wi < widgets.length &&
                    typeof widgets[wi] === 'string' &&
                    /^(fixed|increment|decrement|randomize)$/i.test(widgets[wi])
                ) {
                    wi++;
                } else if (
                    // Heuristic: many seeds put control mode as next string even without the flag in older schemas
                    typeof val === 'number' &&
                    wi < widgets.length &&
                    typeof widgets[wi] === 'string' &&
                    /^(fixed|increment|decrement|randomize)$/i.test(widgets[wi]) &&
                    /seed/i.test(name)
                ) {
                    wi++;
                }

                // Combo widgets — never replace valid file-like strings (LoadImage names).
                // Still coerce misaligned numbers on short enums (scale_method: 360).
                const comboOpts = extractComboOptions(spec);
                if (comboOpts.length) {
                    // Prefer a valid enum/file string already present later in widgets_values
                    // when the current slot is a misaligned number (ResizeImageMaskNode, etc.)
                    if (typeof val === 'number' || (typeof val === 'string' && !comboOpts.includes(val) && !looksLikeFilePathValue(val))) {
                        for (let j = wi - 1; j < widgets.length; j++) {
                            const cand = widgets[j];
                            if (typeof cand === 'string' && comboOpts.includes(cand)) {
                                val = cand;
                                break;
                            }
                        }
                    }
                    const coerced = coerceComboWidgetValue(val, comboOpts, spec, name);
                    if (coerced.changed) {
                        console.warn(
                            `  [COMFY] convertUiToApi ${id}.${name}: ${coerced.reason} → ${JSON.stringify(
                                coerced.value
                            )}`
                        );
                    }
                    val = coerced.value;
                } else if (typeof val === 'number' && Array.isArray(typeName)) {
                    if (val >= 0 && val < typeName.length) val = typeName[val];
                }

                if (!already) {
                    inputs[name] = val;
                }
            }
        } else {
            // No schema: assign widgets_values by unlinked widget inputs in order
            let wi = 0;
            for (const inp of nodeInputs) {
                if (!inp || !inp.name) continue;
                if (inp.link != null) continue;
                if (!inp.widget) continue;
                if (wi >= widgets.length) break;
                inputs[inp.name] = widgets[wi++];
            }
            // Nodes with empty inputs[] but widgets only (e.g. EmptyLatentImage, CheckpointLoader)
            if (!nodeInputs.length && widgets.length) {
                // Best-effort common cases without schema
                if (classType === 'EmptyLatentImage' && widgets.length >= 3) {
                    inputs.width = widgets[0];
                    inputs.height = widgets[1];
                    inputs.batch_size = widgets[2];
                } else if (classType === 'CheckpointLoaderSimple' && widgets.length >= 1) {
                    inputs.ckpt_name = widgets[0];
                } else if (classType === 'SaveImage' && widgets.length >= 1) {
                    inputs.filename_prefix = widgets[0];
                }
            }
        }

        // Ensure SaveImage / similar still have linked image sockets (already set above)
        prompt[id] = {
            class_type: classType,
            inputs,
        };
        // Preserve custom display names so inspect UI can show them (image slots, loaders)
        const displayTitle =
            (node.title != null && String(node.title).trim()) ||
            (node.properties &&
                (node.properties['Node name for S&R'] ||
                    node.properties['Node name'] ||
                    node.properties.cname)) ||
            '';
        if (displayTitle) {
            prompt[id]._meta = { title: String(displayTitle).trim() };
        }
    }

    // Drop dangling links that point at nodes we skipped
    for (const node of Object.values(prompt)) {
        if (!node.inputs) continue;
        for (const [k, v] of Object.entries(node.inputs)) {
            if (Array.isArray(v) && v.length >= 2) {
                if (!prompt[String(v[0])]) {
                    delete node.inputs[k];
                }
            }
        }
    }

    if (!Object.keys(prompt).length) {
        throw new Error('Converted workflow is empty — template may be unsupported');
    }

    return prompt;
}

// ---------------------------------------------------------------------------
// Injection helpers
// ---------------------------------------------------------------------------

const PROMPT_NODE_TYPES = new Set([
    'CLIPTextEncode',
    'CLIPTextEncodeSDXL',
    'CLIPTextEncodeSDXLRefiner',
    'CLIPTextEncodeFlux',
    'CLIPTextEncodeControlnet',
    'TextEncodeQwenImageEdit',
    'StringConstant',
    'StringConstantMultiline',
    'PrimitiveString',
    'PrimitiveStringMultiline',
    'CR Text',
    'Text Multiline',
    'easy positive',
    'easy negative',
]);

const LOAD_IMAGE_TYPES = new Set([
    'LoadImage',
    'LoadImageMask',
    'LoadImageOutput',
    'VHS_LoadImagePath',
]);

const SAVE_IMAGE_TYPES = new Set([
    'SaveImage',
    'SaveImageAdvanced',
    'PreviewImage',
    'SaveAnimatedWEBP',
    'SaveAnimatedPNG',
]);

const SAVE_VIDEO_TYPES = new Set([
    'SaveVideo',
    'SaveWEBM',
    'VHS_VideoCombine',
    'CreateVideo',
    'SaveAnimatedWEBP',
]);

/**
 * Custom display name for a node (Comfy graph title / Node name for S&R / _meta).
 * Used so image-slot and model-slot UIs show user-facing names, not just class types.
 */
function getNodeTitle(nodeApi) {
    if (!nodeApi || typeof nodeApi !== 'object') return '';
    const meta = nodeApi._meta && nodeApi._meta.title;
    if (meta != null && String(meta).trim()) return String(meta).trim();
    if (nodeApi.title != null && String(nodeApi.title).trim()) return String(nodeApi.title).trim();
    const props = nodeApi.properties || {};
    for (const key of ['Node name for S&R', 'Node name', 'cname', 'display_name']) {
        if (props[key] != null && String(props[key]).trim()) return String(props[key]).trim();
    }
    return '';
}

function findNodesByType(apiWf, typeSet) {
    return Object.entries(apiWf).filter(([, n]) => n && typeSet.has(n.class_type));
}

function setNodeTextInput(node, promptText) {
    if (!node.inputs) node.inputs = {};
    if ('text' in node.inputs || !('string' in node.inputs || 'value' in node.inputs)) {
        node.inputs.text = promptText;
    } else if ('string' in node.inputs) {
        node.inputs.string = promptText;
    } else if ('value' in node.inputs) {
        node.inputs.value = promptText;
    } else {
        node.inputs.text = promptText;
    }
}

/** Node ids that feed a sampler/model input named positive* / negative*. */
function promptNodesByGraphRole(apiWf) {
    const positive = new Set();
    const negative = new Set();
    for (const node of Object.values(apiWf)) {
        if (!node || !node.inputs) continue;
        for (const [name, val] of Object.entries(node.inputs)) {
            if (!Array.isArray(val) || val.length < 1) continue;
            const src = String(val[0]);
            if (/^positive/i.test(name) || name === 'conditioning' && /positive/i.test(getNodeTitle(node))) {
                positive.add(src);
            }
            if (/^negative/i.test(name)) {
                negative.add(src);
            }
        }
    }
    return { positive, negative };
}

function injectPrompt(apiWf, promptText) {
    if (!promptText) return { injected: false };

    // Custom markers first
    for (const [id, node] of Object.entries(apiWf)) {
        const title = getNodeTitle(node);
        if (title === '__PROMPT__' || /__PROMPT__/i.test(title)) {
            setNodeTextInput(node, promptText);
            return { injected: true, nodeId: id, via: 'marker' };
        }
    }

    // Prefer graph topology: nodes wired into *.positive inputs (handles SDXL base+refiner)
    const { positive, negative } = promptNodesByGraphRole(apiWf);
    const targets = [];

    if (positive.size) {
        for (const id of positive) {
            if (negative.has(id)) continue;
            const node = apiWf[id];
            if (node) targets.push([id, node]);
        }
    }

    if (!targets.length) {
        // Title / type heuristics
        const textNodes = findNodesByType(apiWf, PROMPT_NODE_TYPES);
        for (const [id, node] of Object.entries(apiWf)) {
            if (textNodes.some(([tid]) => tid === id)) continue;
            if (!node.inputs) continue;
            if (
                typeof node.inputs.text === 'string' &&
                node.class_type &&
                /text|clip|prompt/i.test(node.class_type)
            ) {
                textNodes.push([id, node]);
            }
        }
        for (const pair of textNodes) {
            const [id, n] = pair;
            if (negative.has(id)) continue;
            const title = getNodeTitle(n);
            if (/negative/i.test(title) || /negative/i.test(n.class_type || '')) continue;
            if (/positive/i.test(title)) targets.push(pair);
        }
        if (!targets.length) {
            for (const pair of textNodes) {
                const [id, n] = pair;
                if (negative.has(id)) continue;
                const title = getNodeTitle(n);
                if (/negative/i.test(title)) continue;
                targets.push(pair);
            }
        }
        // Still nothing — first text node only
        if (!targets.length && textNodes.length) targets.push(textNodes[0]);
    }

    if (!targets.length) return { injected: false };

    let count = 0;
    for (const [, node] of targets) {
        setNodeTextInput(node, promptText);
        count++;
    }

    return {
        injected: count > 0,
        nodeId: targets[0][0],
        via: positive.size ? 'graph-positive' : 'heuristic',
        count,
    };
}

function injectSeed(apiWf) {
    const seed = Math.floor(Math.random() * 2 ** 32);
    for (const node of Object.values(apiWf)) {
        if (!node.inputs) continue;
        if ('seed' in node.inputs && typeof node.inputs.seed === 'number') {
            node.inputs.seed = seed;
        }
        if ('noise_seed' in node.inputs && typeof node.inputs.noise_seed === 'number') {
            node.inputs.noise_seed = seed;
        }
    }
    return seed;
}

// ---------------------------------------------------------------------------
// Installed models + workflow model slots (checkpoints / LoRAs)
// ---------------------------------------------------------------------------

const CHECKPOINT_NODE_TYPES = new Set([
    'CheckpointLoaderSimple',
    'CheckpointLoader',
    'unCLIPCheckpointLoader',
    'ImageOnlyCheckpointLoader',
]);

const UNET_NODE_TYPES = new Set(['UNETLoader', 'UnetLoader', 'UNETLoaderGGUF']);

const LORA_NODE_TYPES = new Set([
    'LoraLoader',
    'LoraLoaderModelOnly',
    'LoraLoader|pysssss',
    'LoRA Loader (LoraManager)',
]);

function isLoraClass(classType) {
    if (!classType) return false;
    if (LORA_NODE_TYPES.has(classType)) return true;
    return /lora/i.test(classType) && /loader/i.test(classType);
}

/**
 * List files in a ComfyUI models subfolder (e.g. checkpoints, loras).
 */
async function listModelFolder(baseUrl, folder) {
    const base = resolveBase(baseUrl);
    const safe = String(folder || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!safe) return [];

    try {
        const res = await comfyGet(base, `/models/${encodeURIComponent(safe)}`, 20000);
        if (res.status >= 200 && res.status < 300 && Array.isArray(res.body)) {
            return res.body.map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));
        }
    } catch {
        /* fall through */
    }

    // Fallback: pull combo list from object_info loader nodes
    try {
        const info = await getObjectInfo(base);
        const candidates =
            safe === 'checkpoints'
                ? ['CheckpointLoaderSimple', 'CheckpointLoader']
                : safe === 'loras'
                  ? ['LoraLoader', 'LoraLoaderModelOnly']
                  : safe === 'diffusion_models' || safe === 'unet'
                    ? ['UNETLoader', 'UnetLoader']
                    : safe === 'vae'
                      ? ['VAELoader']
                      : [];
        for (const ct of candidates) {
            const node = info[ct];
            if (!node || !node.input || !node.input.required) continue;
            for (const [name, spec] of Object.entries(node.input.required)) {
                if (!Array.isArray(spec) || !Array.isArray(spec[0])) continue;
                if (/name|ckpt|lora|unet|vae/i.test(name)) {
                    return spec[0].map(String).filter(Boolean);
                }
            }
        }
    } catch {
        /* ignore */
    }
    return [];
}

async function listInstalledModels(baseUrl) {
    const base = resolveBase(baseUrl);
    let folders = ['checkpoints', 'loras', 'vae', 'diffusion_models', 'unet', 'text_encoders'];
    try {
        const res = await comfyGet(base, '/models', 10000);
        if (res.status >= 200 && res.status < 300 && Array.isArray(res.body) && res.body.length) {
            folders = res.body.map(String);
        }
    } catch {
        /* use defaults */
    }

    const out = {};
    await mapPool(folders, 4, async (folder) => {
        out[folder] = await listModelFolder(base, folder);
    });

    // Normalize aliases
    if (!out.checkpoints) out.checkpoints = [];
    if (!out.loras) out.loras = [];
    if (!out.diffusion_models && out.unet) out.diffusion_models = out.unet;

    return {
        folders: Object.keys(out).sort(),
        models: out,
        checkpoints: out.checkpoints || [],
        loras: out.loras || [],
        vae: out.vae || [],
        diffusion_models: out.diffusion_models || out.unet || [],
    };
}

/**
 * Extract combo/file choices from a Comfy object_info input spec.
 * Spec shapes: [ ["a.safetensors", "b.safetensors"], {…} ] or [ "COMBO", { options: [...] } ]
 */
function extractComboOptions(spec) {
    if (!Array.isArray(spec) || !spec.length) return [];
    const head = spec[0];
    if (Array.isArray(head)) {
        return head.map(String).filter((s) => s.length > 0);
    }
    if (typeof head === 'string' && head.toUpperCase() === 'COMBO') {
        const meta = spec[1];
        if (meta && Array.isArray(meta.options)) {
            return meta.options.map(String).filter((s) => s.length > 0);
        }
        if (meta && Array.isArray(meta.choices)) {
            return meta.choices.map(String).filter((s) => s.length > 0);
        }
    }
    return [];
}

/** True if string looks like a media/model file path Comfy may accept outside the current combo list. */
function looksLikeFilePathValue(val) {
    if (typeof val !== 'string' || !val.trim()) return false;
    return /\.(png|jpe?g|webp|gif|bmp|safetensors|sft|ckpt|pt|bin|gguf|pth|mp4|webm|mov|wav|mp3|flac)$/i.test(
        val.trim()
    );
}

/**
 * Combo lists from object_info are often incomplete (input folder scan, filtered models).
 * - Always keep non-empty strings that look like files (LoadImage image names, checkpoints, …).
 * - Only coerce numbers / non-file strings that are clearly not in a short enum list.
 * @returns {{ value: unknown, changed: boolean, reason?: string }}
 */
function coerceComboWidgetValue(val, options, spec, fieldName) {
    const opts = Array.isArray(options) ? options : [];
    if (!opts.length) return { value: val, changed: false };

    if (typeof val === 'string') {
        if (opts.includes(val)) return { value: val, changed: false };
        // LoadImage etc.: filename not currently listed still valid on disk
        if (looksLikeFilePathValue(val) || /^image$/i.test(fieldName || '')) {
            return { value: val, changed: false };
        }
        // Short enums (scale_method, resize_type, crop, …) — replace unknown tokens
        const def = spec && spec[1] && spec[1].default != null ? spec[1].default : opts[0];
        const fallback = opts.includes(def) ? def : opts[0];
        return { value: fallback, changed: true, reason: `unknown enum ${JSON.stringify(val)}` };
    }

    if (typeof val === 'number' && Number.isFinite(val)) {
        if (val >= 0 && val < opts.length && Number.isInteger(val)) {
            return { value: opts[val], changed: true, reason: `index ${val}` };
        }
        // Misaligned widget (e.g. height 360 into scale_method) — use default, never keep the number
        const def = spec && spec[1] && spec[1].default != null ? spec[1].default : opts[0];
        const fallback = opts.includes(def) ? def : opts[0];
        return { value: fallback, changed: true, reason: `non-index number ${val}` };
    }

    if (val == null) {
        const def = spec && spec[1] && spec[1].default != null ? spec[1].default : opts[0];
        const fallback = opts.includes(def) ? def : opts[0];
        return { value: fallback, changed: true, reason: 'null' };
    }

    return { value: val, changed: false };
}

function getFieldOptionsFromObjectInfo(objectInfo, classType, fieldName) {
    if (!objectInfo || !classType || !fieldName) return [];
    const info = objectInfo[classType];
    if (!info || !info.input) return [];
    for (const section of ['required', 'optional']) {
        const block = info.input[section] || {};
        if (block[fieldName]) {
            return extractComboOptions(block[fieldName]);
        }
    }
    return [];
}

function looksLikeModelCombo(fieldName, options) {
    if (
        /^(ckpt_name|unet_name|lora_name|vae_name|model_name|clip_name|clip_name1|clip_name2|clip_name3|diffusion_model|model|text_encoder|text_encoder_name|encoder_name)$/i.test(
            fieldName
        )
    ) {
        return true;
    }
    // text_encoder / gemma-style fields (no "name" substring)
    if (/text_?encoder|gemma|t5xxl|llm/i.test(fieldName)) return true;
    if (!/name|model|ckpt|unet|lora|vae|clip|diffusion|encoder/i.test(fieldName)) return false;
    if (!options.length) return false;
    // File-like entries (Comfy often filters by folder → only valid files appear)
    const sample = options.slice(0, 12);
    return sample.some((o) => /\.(safetensors|sft|ckpt|pt|bin|gguf|pth)$/i.test(o) || o.includes('/') || o.includes('\\'));
}

function classifyModelField(fieldName, classType) {
    const f = String(fieldName || '').toLowerCase();
    const c = String(classType || '').toLowerCase();
    if (f.includes('lora') || c.includes('lora')) return 'lora';
    // Audio VAE loaders often use ckpt_name but are not diffusion checkpoints
    if (c.includes('audiovae') || (c.includes('audio') && c.includes('vae'))) return 'vae';
    if (f.includes('vae') || (c.includes('vae') && !c.includes('audio'))) return 'vae';
    if (f.includes('unet') || f.includes('diffusion') || c.includes('unet')) return 'unet';
    // Gemma / T5 / text encoders — never treat as SD checkpoint (field-first)
    if (
        f.includes('text_encoder') ||
        f === 'encoder_name' ||
        f.includes('gemma') ||
        f.includes('t5') ||
        (f.includes('clip') && !f.includes('ckpt'))
    ) {
        return 'clip';
    }
    // Class is a text-encoder loader but this widget is still a ckpt/vae path
    if (f.includes('ckpt') || (c.includes('checkpoint') && !c.includes('audio'))) return 'checkpoint';
    if (
        (c.includes('textencoder') || c.includes('text_encoder')) &&
        !f.includes('ckpt') &&
        !f.includes('vae')
    ) {
        return 'clip';
    }
    if (f.includes('clip') || c.includes('clip')) return 'clip';
    if (f === 'model_name' || f === 'model') {
        if (c.includes('unet') || c.includes('diffusion') || c.includes('ltx')) return 'unet';
        if (c.includes('text') || c.includes('encoder') || c.includes('clip')) return 'clip';
        return 'checkpoint';
    }
    return 'other';
}

/** Client/UI sentinel — must never be written into a Comfy workflow. */
const WORKFLOW_DEFAULT_SENTINEL = '__as_workflow_default__';

function ensureOption(options, current) {
    const list = Array.isArray(options) ? [...options] : [];
    if (current && !list.includes(current)) list.unshift(current);
    return list;
}

/**
 * Inspect API workflow for swappable model loaders.
 * Uses Comfy `object_info` combo lists so each node only offers models Comfy accepts
 * for that class (LTX vs SD checkpoints vs diffusion UNETs, etc.).
 *
 * @param {object} apiWf
 * @param {object} [objectInfo]
 */
function analyzeWorkflowModels(apiWf, objectInfo) {
    const checkpoints = [];
    const unets = [];
    const loras = [];
    const vaes = [];
    const clips = [];
    const other = [];
    const seen = new Set(); // nodeId::field

    for (const [id, node] of Object.entries(apiWf || {})) {
        if (!node || !node.class_type) continue;
        const ct = node.class_type;
        const title = getNodeTitle(node);
        const inputs = node.inputs || {};
        const info = objectInfo && objectInfo[ct];

        // Prefer object_info: every combo field that looks like a model file picker
        if (info && info.input) {
            for (const section of ['required', 'optional']) {
                const block = info.input[section] || {};
                for (const [field, spec] of Object.entries(block)) {
                    const key = `${id}::${field}`;
                    if (seen.has(key)) continue;

                    // Skip if the API input is a live link (not a free widget value)
                    const curVal = inputs[field];
                    if (Array.isArray(curVal)) continue; // linked socket

                    const options = extractComboOptions(spec);
                    if (!looksLikeModelCombo(field, options)) continue;

                    // Resolve the value actually stored on the workflow node.
                    // Do NOT fall back to options[0] — that is only the combo list order,
                    // not the graph's selection (was mislabeled as "Workflow Default").
                    let current = '';
                    if (typeof curVal === 'string') {
                        current = curVal;
                    } else if (typeof curVal === 'number' && options.length) {
                        // Combo index stored as number
                        if (curVal >= 0 && curVal < options.length) current = String(options[curVal]);
                    } else if (curVal != null && !Array.isArray(curVal)) {
                        // Skip non-widget linked-looking values
                        continue;
                    }
                    // curVal missing/undefined → current stays '' (unknown / template placeholder)

                    const kind = classifyModelField(field, ct);
                    const slot = {
                        nodeId: id,
                        classType: ct,
                        title: title || `${ct} ${id}`,
                        field,
                        current,
                        options: ensureOption(options, current),
                        kind,
                    };
                    seen.add(key);

                    if (kind === 'lora') {
                        loras.push({
                            ...slot,
                            lora_name: current,
                            strength_model:
                                typeof inputs.strength_model === 'number' ? inputs.strength_model : 1,
                            strength_clip:
                                typeof inputs.strength_clip === 'number'
                                    ? inputs.strength_clip
                                    : typeof inputs.strength_model === 'number'
                                      ? inputs.strength_model
                                      : 1,
                            enabled:
                                (typeof inputs.strength_model === 'number'
                                    ? inputs.strength_model
                                    : 1) !== 0 ||
                                (typeof inputs.strength_clip === 'number'
                                    ? inputs.strength_clip
                                    : 1) !== 0,
                        });
                    } else if (kind === 'unet') {
                        unets.push(slot);
                    } else if (kind === 'vae') {
                        vaes.push(slot);
                    } else if (kind === 'clip') {
                        clips.push(slot);
                    } else if (kind === 'checkpoint') {
                        checkpoints.push(slot);
                    } else {
                        other.push(slot);
                        // Unknown loaders: still expose as checkpoint-like for UI if field is ckpt-like
                        if (/ckpt|model/i.test(field)) checkpoints.push(slot);
                    }
                }
            }
        }

        // Fallback heuristics when object_info missing for custom nodes
        if (!info) {
            const tryField = (field, bucket) => {
                const key = `${id}::${field}`;
                if (seen.has(key)) return;
                if (!(field in inputs)) return;
                if (Array.isArray(inputs[field])) return;
                if (typeof inputs[field] !== 'string') return;
                seen.add(key);
                const current = inputs[field];
                const slot = {
                    nodeId: id,
                    classType: ct,
                    title: title || `${ct} ${id}`,
                    field,
                    current,
                    options: ensureOption([], current),
                    kind: classifyModelField(field, ct),
                };
                bucket.push(slot);
            };

            if (CHECKPOINT_NODE_TYPES.has(ct) || /checkpoint|ltx.*load/i.test(ct)) {
                tryField('ckpt_name', checkpoints);
            }
            if (UNET_NODE_TYPES.has(ct) || /unet|diffusion/i.test(ct)) {
                if ('unet_name' in inputs) tryField('unet_name', unets);
                else tryField('model_name', unets);
            }
            if (isLoraClass(ct)) {
                const key = `${id}::lora_name`;
                if (!seen.has(key) && typeof inputs.lora_name === 'string') {
                    seen.add(key);
                    loras.push({
                        nodeId: id,
                        classType: ct,
                        title: title || `LoRA ${id}`,
                        field: 'lora_name',
                        current: inputs.lora_name,
                        options: ensureOption([], inputs.lora_name),
                        kind: 'lora',
                        lora_name: inputs.lora_name,
                        strength_model:
                            typeof inputs.strength_model === 'number' ? inputs.strength_model : 1,
                        strength_clip:
                            typeof inputs.strength_clip === 'number' ? inputs.strength_clip : 1,
                        enabled: true,
                    });
                }
            }
            if (ct === 'VAELoader' || /vaeloader/i.test(ct)) tryField('vae_name', vaes);
        }
    }

    return { checkpoints, unets, loras, vaes, clips, other };
}

/**
 * Load + convert a workflow source (same as generate) for inspection.
 */
async function loadApiWorkflow(baseUrl, { templateId, customWorkflow } = {}) {
    const base = resolveBase(baseUrl);
    let workflowRaw;
    if (customWorkflow) {
        workflowRaw =
            typeof customWorkflow === 'string' ? JSON.parse(customWorkflow) : customWorkflow;
    } else if (templateId) {
        workflowRaw = await resolveWorkflowSource(base, templateId);
    } else {
        throw new Error('templateId or customWorkflow required');
    }

    const normalized = normalizeWorkflowRaw(workflowRaw);
    if (normalized.kind === 'api') {
        // Pass through API-format graphs with no UI conversion (avoids mangling video graphs)
        return JSON.parse(JSON.stringify(normalized.workflow));
    }

    const objectInfo = await getObjectInfo(base);
    try {
        return convertUiToApi(normalized.workflow, objectInfo);
    } catch (err) {
        throw new Error(
            `Could not convert workflow to API format: ${err.message}. ` +
                'In ComfyUI enable Dev mode → Save (API Format), then load that file here.'
        );
    }
}

/**
 * Apply user model overrides onto an API workflow.
 * @param {object} apiWf
 * @param {{
 *   checkpoints?: Array<{ nodeId: string, ckpt_name: string }>,
 *   unets?: Array<{ nodeId: string, unet_name: string }>,
 *   vaes?: Array<{ nodeId: string, vae_name: string }>,
 *   loras?: Array<{ nodeId: string, enabled?: boolean, lora_name?: string, strength_model?: number, strength_clip?: number }>,
 *   checkpoint?: string  // convenience: apply to ALL checkpoint loaders
 * }} models
 */
function isWorkflowDefaultSentinel(val) {
    if (val == null) return true;
    const s = String(val).trim();
    return !s || s === WORKFLOW_DEFAULT_SENTINEL || s === '__workflow_default__';
}

/**
 * Apply a single field override only when it actually changes the graph.
 * Never writes the Workflow Default sentinel into Comfy.
 */
function applyFieldOverride(apiWf, nodeId, field, value, applied, skipped, classHint) {
    if (isWorkflowDefaultSentinel(value)) {
        skipped.push({ nodeId: String(nodeId), field, reason: 'workflow_default (no inject)' });
        return;
    }
    const node = apiWf[String(nodeId)];
    if (!node || !node.inputs) {
        skipped.push({ nodeId: String(nodeId), field, reason: 'missing node' });
        return;
    }
    if (!(field in node.inputs)) {
        skipped.push({ nodeId: String(nodeId), field, reason: `no ${field} input` });
        return;
    }
    if (Array.isArray(node.inputs[field])) {
        skipped.push({ nodeId: String(nodeId), field, reason: `${field} is linked` });
        return;
    }
    if (node.inputs[field] === value) {
        skipped.push({ nodeId: String(nodeId), field, reason: 'unchanged', value });
        return;
    }
    const prev = node.inputs[field];
    node.inputs[field] = value;
    applied.push({
        nodeId: String(nodeId),
        field,
        value,
        previous: prev,
        classType: node.class_type || classHint,
    });
}

function injectModels(apiWf, models) {
    if (!models || typeof models !== 'object') return { applied: [], skipped: [] };
    const applied = [];
    const skipped = [];

    // NOTE: Do NOT broadcast a single checkpoint onto every loader — LTX/video graphs
    // often mix CheckpointLoader + text encoder (Gemma) + audio VAE with incompatible files.
    // Only per-node+field overrides are applied, and only when the value actually changes.
    // Workflow Default / empty / sentinel → never inject.

    /**
     * Generic per-node field override (preferred).
     * body.models.overrides: [{ nodeId, field, value }]
     */
    for (const row of models.overrides || []) {
        if (!row || !row.nodeId || !row.field) continue;
        applyFieldOverride(apiWf, row.nodeId, String(row.field), row.value, applied, skipped);
    }

    for (const row of models.checkpoints || []) {
        if (!row || !row.nodeId) continue;
        applyFieldOverride(
            apiWf,
            row.nodeId,
            row.field || 'ckpt_name',
            row.ckpt_name || row.value,
            applied,
            skipped
        );
    }

    for (const row of models.unets || []) {
        if (!row || !row.nodeId) continue;
        const node = apiWf[String(row.nodeId)];
        const field =
            row.field ||
            (node && node.inputs && 'unet_name' in node.inputs ? 'unet_name' : 'model_name');
        applyFieldOverride(apiWf, row.nodeId, field, row.unet_name || row.value, applied, skipped);
    }

    for (const row of models.vaes || []) {
        if (!row || !row.nodeId) continue;
        applyFieldOverride(
            apiWf,
            row.nodeId,
            row.field || 'vae_name',
            row.vae_name || row.value,
            applied,
            skipped
        );
    }

    for (const row of models.clips || []) {
        if (!row || !row.nodeId) continue;
        applyFieldOverride(
            apiWf,
            row.nodeId,
            row.field || 'clip_name',
            row.clip_name || row.value || row.text_encoder,
            applied,
            skipped
        );
    }

    for (const row of models.loras || []) {
        if (!row || !row.nodeId) continue;
        const node = apiWf[String(row.nodeId)];
        if (!node || !node.inputs) continue;

        if (row.enabled === false) {
            // Strength 0 = effectively off without rewiring the graph
            if ('strength_model' in node.inputs) node.inputs.strength_model = 0;
            if ('strength_clip' in node.inputs) node.inputs.strength_clip = 0;
            applied.push({ nodeId: String(row.nodeId), field: 'lora', value: 'disabled (strength 0)' });
            continue;
        }

        if (typeof row.lora_name === 'string' && row.lora_name.trim()) {
            node.inputs.lora_name = row.lora_name.trim();
        }
        if (typeof row.strength_model === 'number' && !Number.isNaN(row.strength_model)) {
            node.inputs.strength_model = row.strength_model;
        }
        if (typeof row.strength_clip === 'number' && !Number.isNaN(row.strength_clip)) {
            if ('strength_clip' in node.inputs) node.inputs.strength_clip = row.strength_clip;
        } else if (
            typeof row.strength_model === 'number' &&
            'strength_clip' in node.inputs &&
            row.strength_clip === undefined
        ) {
            node.inputs.strength_clip = row.strength_model;
        }
        applied.push({
            nodeId: String(row.nodeId),
            field: 'lora',
            value: node.inputs.lora_name,
            strength_model: node.inputs.strength_model,
            strength_clip: node.inputs.strength_clip,
        });
    }

    if (applied.length) {
        console.log(
            '  [COMFY] Model overrides applied:',
            applied
                .map(
                    (a) =>
                        `${a.nodeId}${a.classType ? `(${a.classType})` : ''}.${a.field}: ${
                            a.previous != null ? `${a.previous} → ` : ''
                        }${a.value}`
                )
                .join(' | ')
                .slice(0, 600)
        );
    } else {
        console.log('  [COMFY] No model overrides (using workflow defaults)');
    }
    return { applied, skipped };
}

/**
 * Before /prompt: coerce free COMBO widgets to values Comfy accepts.
 * - Keeps LoadImage / checkpoint file strings even if not in the current combo list
 * - Fixes mangled numbers (scale_method: 360)
 * Does not touch linked inputs (arrays).
 */
function sanitizeApiWorkflowCombos(apiWf, objectInfo) {
    if (!apiWf || !objectInfo || typeof objectInfo !== 'object') return { fixed: 0 };
    let fixed = 0;
    for (const [id, node] of Object.entries(apiWf)) {
        if (!node || !node.class_type || !node.inputs) continue;
        const info = objectInfo[node.class_type];
        if (!info || !info.input) continue;
        for (const section of ['required', 'optional']) {
            const block = info.input[section] || {};
            for (const [field, spec] of Object.entries(block)) {
                const options = extractComboOptions(spec);
                if (!options.length) continue;
                const val = node.inputs[field];
                if (val == null || Array.isArray(val)) continue; // missing or linked
                const coerced = coerceComboWidgetValue(val, options, spec, field);
                if (!coerced.changed) continue;
                console.warn(
                    `  [COMFY] sanitize ${id}.${field}: ${coerced.reason} → ${JSON.stringify(
                        coerced.value
                    )} (${node.class_type})`
                );
                node.inputs[field] = coerced.value;
                fixed++;
            }
        }
    }
    if (fixed) {
        console.log(`  [COMFY] Sanitized ${fixed} invalid combo widget value(s) before /prompt`);
    }
    return { fixed };
}

/**
 * Repair nodes whose nested/dynamic widgets don't round-trip cleanly through object_info order.
 * (ResizeImageMaskNode is the main offender for LTX first/last-frame templates.)
 */
function repairKnownNodeInputs(apiWf) {
    if (!apiWf || typeof apiWf !== 'object') return { fixed: 0 };
    let fixed = 0;
    const SCALE_METHODS = ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'];
    for (const [id, node] of Object.entries(apiWf)) {
        if (!node || !node.inputs || !node.class_type) continue;
        const ct = node.class_type;
        const inputs = node.inputs;

        if (/ResizeImageMask/i.test(ct)) {
            if (typeof inputs.resize_type !== 'string' || !inputs.resize_type.trim()) {
                inputs.resize_type = 'scale dimensions';
                fixed++;
                console.warn(`  [COMFY] repair ${id}.resize_type → "scale dimensions"`);
            }
            if (
                typeof inputs.scale_method !== 'string' ||
                !SCALE_METHODS.includes(inputs.scale_method)
            ) {
                inputs.scale_method = 'nearest-exact';
                fixed++;
                console.warn(`  [COMFY] repair ${id}.scale_method → "nearest-exact"`);
            }
            if (
                inputs['resize_type.crop'] != null &&
                typeof inputs['resize_type.crop'] !== 'string'
            ) {
                inputs['resize_type.crop'] = 'center';
                fixed++;
            } else if (inputs['resize_type.crop'] == null && /scale/i.test(String(inputs.resize_type))) {
                // crop is often required for "scale dimensions" mode
                inputs['resize_type.crop'] = 'center';
                fixed++;
            }
        }

        // LoadImage: image must be a string filename if free (not a link)
        if (/^LoadImage/i.test(ct) || ct === 'LoadImageOutput') {
            if (inputs.image != null && !Array.isArray(inputs.image) && typeof inputs.image !== 'string') {
                console.warn(
                    `  [COMFY] repair ${id}.image: dropping non-string ${JSON.stringify(inputs.image)}`
                );
                delete inputs.image;
                fixed++;
            }
        }
    }
    if (fixed) console.log(`  [COMFY] Repaired ${fixed} known-node input(s) before /prompt`);
    return { fixed };
}

/** Only rewrite size on empty-latent / canvas nodes — never on model or sampler nodes. */
const SIZE_INJECT_CLASS_RE =
    /Empty(Latent|Image)|LatentImage|SolidMask|EmptySD3Latent|EmptyCosmos|EmptyHunyuan|EmptyMochi|EmptyLTXV|WanEmpty|ImageBlank/i;

/**
 * Optionally set width/height on empty-latent style nodes only.
 * Blindly patching every node with width/height breaks many video graphs (Wan/Hunyuan/etc.)
 * and can stall at "loading model" while VRAM thrash / alloc retries happen.
 */
function injectSize(apiWf, width, height) {
    if (!width || !height) return { applied: 0 };
    let applied = 0;
    for (const node of Object.values(apiWf)) {
        if (!node || !node.inputs) continue;
        const ct = node.class_type || '';
        if (!SIZE_INJECT_CLASS_RE.test(ct)) continue;
        if ('width' in node.inputs && typeof node.inputs.width === 'number') {
            node.inputs.width = width;
            applied++;
        }
        if ('height' in node.inputs && typeof node.inputs.height === 'number') {
            node.inputs.height = height;
            applied++;
        }
    }
    return { applied };
}

async function uploadImage(baseUrl, dataUrlOrB64, filename) {
    const base = resolveBase(baseUrl);
    let raw = dataUrlOrB64;
    let contentType = 'image/png';
    if (typeof raw === 'string' && raw.startsWith('data:')) {
        const m = raw.match(/^data:([^;]+);base64,(.*)$/);
        if (m) {
            contentType = m[1] || contentType;
            raw = m[2];
        }
    }
    const buf = Buffer.from(raw, 'base64');
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
    const name = filename || `as_upload_${Date.now()}.${ext}`;

    const form = new FormData();
    form.append('image', buf, { filename: name, contentType });
    form.append('overwrite', 'true');
    form.append('type', 'input');

    const url = `${base}/upload/image`;
    const resp = await nodeFetch(url, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
        timeout: 120000,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(data.error || data.message || `Image upload failed (HTTP ${resp.status})`);
    }
    // Response: { name, subfolder, type }
    return data.name || name;
}

/**
 * List LoadImage-like nodes in workflow order (deterministic Object.entries order).
 * Used by inspect-workflow so the client can bind app images (char/style/start/end) to slots.
 */
function analyzeWorkflowImages(apiWf) {
    const slots = [];
    const loaders = findNodesByType(apiWf, LOAD_IMAGE_TYPES);
    for (let index = 0; index < loaders.length; index++) {
        const [id, node] = loaders[index];
        const customTitle = getNodeTitle(node);
        const classType = (node && node.class_type) || 'LoadImage';
        // Prefer custom display name; fall back to class + id so the UI never shows a blank label
        const title = customTitle || `${classType} ${id}`;
        const inputs = (node && node.inputs) || {};
        slots.push({
            nodeId: String(id),
            classType,
            title,
            /** True when title came from a user/custom node name (not just class+id). */
            hasCustomTitle: !!customTitle,
            field: 'image',
            current: typeof inputs.image === 'string' ? inputs.image : '',
            index,
        });
    }
    return { images: slots, imageSlotCount: slots.length };
}

/**
 * @param {string} baseUrl
 * @param {object} apiWf
 * @param {Array<string|{label?:string,data:string,nodeId?:string,slot?:string}>} images
 *   Optional nodeId/slot pins an uploaded file to a specific LoadImage node id.
 */
async function injectImages(baseUrl, apiWf, images) {
    // images: [{ label?, data, nodeId? }] data is base64 or data-URL
    if (!images || !images.length) return { uploaded: [] };

    const uploaded = [];
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const data = typeof img === 'string' ? img : img.data;
        if (!data) continue;
        const label = (typeof img === 'object' && img.label) || `ref_${i}`;
        const nodeId =
            typeof img === 'object' && (img.nodeId != null || img.slot != null)
                ? String(img.nodeId != null ? img.nodeId : img.slot)
                : null;
        const filename = `as_${label.replace(/[^a-zA-Z0-9_-]/g, '_')}_${i}.png`;
        const name = await uploadImage(baseUrl, data, filename);
        uploaded.push({ index: i, label, name, nodeId });
    }

    if (!uploaded.length) return { uploaded };

    // Marker nodes __IMAGE_0__ etc.
    for (const u of uploaded) {
        const marker = `__IMAGE_${u.index}__`;
        for (const node of Object.values(apiWf)) {
            const title = getNodeTitle(node);
            if (title === marker || title.includes(marker)) {
                if (node.inputs) node.inputs.image = u.name;
            }
        }
    }

    const loaders = findNodesByType(apiWf, LOAD_IMAGE_TYPES);
    const loaderById = new Map(loaders.map(([id, node]) => [String(id), node]));
    const usedLoaderIds = new Set();

    // Explicit nodeId bindings first
    for (const u of uploaded) {
        if (!u.nodeId) continue;
        const node = loaderById.get(u.nodeId) || apiWf[u.nodeId];
        if (node && node.inputs) {
            node.inputs.image = u.name;
            usedLoaderIds.add(u.nodeId);
        }
    }

    // Remaining images fill unbound LoadImage nodes in order
    const unbound = uploaded.filter((u) => !u.nodeId || !usedLoaderIds.has(u.nodeId));
    let unboundIdx = 0;
    for (const [id, node] of loaders) {
        if (usedLoaderIds.has(String(id))) continue;
        if (unboundIdx >= unbound.length) break;
        if (node.inputs) node.inputs.image = unbound[unboundIdx].name;
        usedLoaderIds.add(String(id));
        unboundIdx++;
    }

    // If only one image and no loaders matched, try any node with "image" string input
    if (uploaded.length && !loaders.length) {
        for (const node of Object.values(apiWf)) {
            if (node.inputs && typeof node.inputs.image === 'string') {
                node.inputs.image = uploaded[0].name;
                break;
            }
        }
    }

    return { uploaded };
}

// ---------------------------------------------------------------------------
// Generate pipeline
// ---------------------------------------------------------------------------

/**
 * Run fn with exclusive access per Comfy base URL (prevents parallel 22B loads).
 */
async function withComfyGenerateLock(baseUrl, fn) {
    const key = String(baseUrl || '');
    const prev = generateLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    // Next waiter chains onto us
    generateLocks.set(
        key,
        prev.then(() => gate).catch(() => gate)
    );
    // Wait for previous generate to fully finish
    try {
        await prev;
    } catch {
        /* ignore prior failure */
    }
    try {
        return await fn();
    } finally {
        release();
    }
}

async function getComfyQueueSnapshot(baseUrl) {
    try {
        const res = await comfyGet(baseUrl, '/queue', 5000);
        if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
            const running = Array.isArray(res.body.queue_running) ? res.body.queue_running : [];
            const pending = Array.isArray(res.body.queue_pending) ? res.body.queue_pending : [];
            return { running, pending, runningCount: running.length, pendingCount: pending.length };
        }
    } catch {
        /* ignore */
    }
    return { running: [], pending: [], runningCount: 0, pendingCount: 0 };
}

/**
 * Snapshot VRAM/RAM from /system_stats (best-effort).
 */
async function getComfyMemorySnapshot(baseUrl) {
    try {
        const res = await comfyGet(baseUrl, '/system_stats', 8000);
        if (res.status < 200 || res.status >= 300 || !res.body) return null;
        const sys = res.body.system || {};
        const dev = (res.body.devices && res.body.devices[0]) || {};
        return {
            ramFree: sys.ram_free || 0,
            ramTotal: sys.ram_total || 0,
            vramFree: dev.vram_free || 0,
            vramTotal: dev.vram_total || 0,
            torchVramFree: dev.torch_vram_free || 0,
            torchVramTotal: dev.torch_vram_total || 0,
            deviceName: dev.name || '',
        };
    } catch {
        return null;
    }
}

function formatBytes(n) {
    if (!n || n < 0) return '?';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${n} B`;
}

/**
 * Ask ComfyUI to unload models / free memory before a heavy job.
 * POST /free { unload_models, free_memory } — applied between queue items by Comfy.
 * Docs: server.py post_free
 */
async function freeComfyMemory(baseUrl, { unloadModels = true, freeMemory = true } = {}) {
    const base = resolveBase(baseUrl);
    const before = await getComfyMemorySnapshot(base);
    await comfyPostJson(
        base,
        '/free',
        {
            unload_models: !!unloadModels,
            free_memory: !!freeMemory,
        },
        30000
    );
    // Give the executor a moment to process flags (runs between prompts / idle)
    await new Promise((r) => setTimeout(r, 750));
    const after = await getComfyMemorySnapshot(base);
    console.log(
        `  [COMFY] /free unload_models=${!!unloadModels} free_memory=${!!freeMemory}` +
            (before
                ? `  VRAM ${formatBytes(before.vramFree)}→${formatBytes(after && after.vramFree)} free` +
                  `  RAM ${formatBytes(before.ramFree)}→${formatBytes(after && after.ramFree)} free`
                : '')
    );
    return { before, after };
}

async function queuePrompt(baseUrl, apiWorkflow, clientId) {
    const base = resolveBase(baseUrl);
    // Match Comfy frontend envelope closely (extra_data is optional but expected by some hooks)
    const res = await comfyPostJson(
        base,
        '/prompt',
        {
            prompt: apiWorkflow,
            client_id: clientId || crypto.randomUUID(),
            extra_data: {
                comfy_usage_source: 'as-adventurer',
            },
        },
        120000
    );

    // Comfy returns 400 with { error: {message,type,details}, node_errors } on validation failure.
    // Sometimes error is present even on other statuses.
    if (res.status < 200 || res.status >= 300 || (res.body && res.body.error)) {
        const msg = formatComfyError(
            res.body,
            `ComfyUI /prompt failed (HTTP ${res.status || 0})`
        );
        console.error('  [COMFY] /prompt error body:', typeof res.body === 'string' ? res.body : JSON.stringify(res.body).slice(0, 1500));
        throw new Error(msg);
    }

    const promptId = res.body && res.body.prompt_id;
    if (!promptId) {
        throw new Error(
            formatComfyError(res.body, 'ComfyUI did not return prompt_id')
        );
    }
    return promptId;
}

function summarizeHistoryError(entry) {
    if (!entry || !entry.status) return null;
    if (entry.status.status_str === 'error' || entry.status.completed === false) {
        const msgs = entry.status.messages || [];
        const parts = [];
        for (const m of msgs) {
            if (!Array.isArray(m)) {
                parts.push(JSON.stringify(m));
                continue;
            }
            const [type, payload] = m;
            if (type === 'execution_error' && payload) {
                parts.push(
                    payload.exception_message ||
                        payload.message ||
                        payload.exception_type ||
                        JSON.stringify(payload).slice(0, 400)
                );
                if (payload.node_type || payload.node_id) {
                    parts.push(`node ${payload.node_id || '?'} (${payload.node_type || '?'})`);
                }
            } else if (type === 'execution_interrupted') {
                parts.push('execution interrupted');
            } else if (payload && payload.exception_message) {
                parts.push(payload.exception_message);
            }
        }
        return parts.filter(Boolean).join(' — ') || 'ComfyUI execution error';
    }
    return null;
}

/**
 * Poll /history until this prompt has outputs (or errors).
 *
 * Important: This is NOT a ComfyUI API limitation — the same /prompt endpoint
 * as the desktop UI. We only time out on *our* wait loop. Long silent phases
 * (LTX / Gemma / VAE load after /free) are normal and must not be treated as failure.
 *
 * @param {string} baseUrl
 * @param {string} promptId
 * @param {number|object} maxWaitMsOrOpts absolute max ms, or { absoluteMaxMs, idleGraceMs, onWait, activity }
 */
async function waitForHistory(baseUrl, promptId, maxWaitMsOrOpts = GENERATE_MAX_WAIT_MS, onWaitMaybe) {
    const opts =
        maxWaitMsOrOpts && typeof maxWaitMsOrOpts === 'object'
            ? maxWaitMsOrOpts
            : { absoluteMaxMs: maxWaitMsOrOpts, onWait: onWaitMaybe };
    const absoluteMaxMs = opts.absoluteMaxMs || GENERATE_MAX_WAIT_MS;
    const idleGraceMs = opts.idleGraceMs != null ? opts.idleGraceMs : GENERATE_IDLE_GRACE_MS;
    const onWait = opts.onWait;
    /** External bump from websocket progress (optional). */
    const activity = opts.activity || { lastAt: Date.now() };
    if (activity.lastAt == null) activity.lastAt = Date.now();
    activity.bump = () => {
        activity.lastAt = Date.now();
    };

    const base = resolveBase(baseUrl);
    const start = Date.now();
    let lastLog = 0;
    let pollMs = GENERATE_POLL_MS;
    let sawInHistory = false;

    while (true) {
        const now = Date.now();
        const elapsed = now - start;

        if (elapsed >= absoluteMaxMs) {
            throw new Error(
                `ComfyUI generation timed out after ${Math.round(elapsed / 60000)} minutes waiting for outputs. ` +
                    'This is the app wait limit (not a Comfy API cap). Check the ComfyUI window for a stuck model/VAE load, ' +
                    'VRAM thrash after “Unload models before run”, or a job stuck in the queue. ' +
                    'The same graph often finishes faster in the Comfy UI if models are already warm.'
            );
        }

        let snap = { runningCount: 0, pendingCount: 0 };
        try {
            snap = await getComfyQueueSnapshot(base);
        } catch {
            /* ignore */
        }
        // Queue activity = job still alive — never treat as "idle dead"
        if (snap.runningCount > 0 || snap.pendingCount > 0) {
            activity.bump();
        }

        try {
            const res = await comfyGet(base, `/history/${encodeURIComponent(promptId)}`, 30000);
            if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') {
                const entry = res.body[promptId] || res.body;
                if (entry && (entry.outputs || entry.status)) {
                    sawInHistory = true;
                    activity.bump();
                }
                const errMsg = summarizeHistoryError(entry);
                if (errMsg) throw new Error(errMsg);
                // Prefer non-empty outputs (SaveVideo / SaveImage finished)
                if (entry && entry.outputs && Object.keys(entry.outputs).length > 0) {
                    return entry;
                }
                // Completed successfully with empty outputs object — still return (caller errors if no media)
                if (
                    entry &&
                    entry.status &&
                    entry.status.status_str === 'success' &&
                    entry.status.completed
                ) {
                    return entry;
                }
            }
        } catch (err) {
            // Network blip while Comfy is busy loading — don't kill the job
            if (err && err.message && !/execution|node |invalid/i.test(err.message)) {
                if (now - lastLog > 15000) {
                    console.warn(
                        `  [COMFY] history poll error (will retry): ${err.message}`
                    );
                }
            } else {
                throw err;
            }
        }

        // Idle abort: nothing running/pending AND no recent activity AND not just queued
        const idleFor = now - (activity.lastAt || start);
        if (
            snap.runningCount === 0 &&
            snap.pendingCount === 0 &&
            idleFor >= idleGraceMs &&
            elapsed > idleGraceMs
        ) {
            throw new Error(
                `ComfyUI went idle for ${Math.round(idleFor / 60000)} minutes with no outputs for this job` +
                    (sawInHistory ? ' (history entry incomplete).' : ' (prompt never appeared in history).') +
                    ' Check the ComfyUI console for crashes or an interrupted queue.'
            );
        }

        if (now - lastLog > 15000) {
            lastLog = now;
            const elapsedS = Math.round(elapsed / 1000);
            // During long model allocate phases, poll Comfy less often (HTTP competes with work)
            pollMs = elapsedS > 25 ? GENERATE_POLL_MS_SLOW : GENERATE_POLL_MS;
            console.log(
                `  [COMFY] waiting prompt=${String(promptId).slice(0, 8)}… ${elapsedS}s  queue running=${snap.runningCount} pending=${snap.pendingCount}`
            );
            if (typeof onWait === 'function') {
                const inQueue = snap.pendingCount > 0 && snap.runningCount === 0;
                const capMin = Math.round(absoluteMaxMs / 60000);
                onWait({
                    status: inQueue ? 'queued' : 'running',
                    message: inQueue
                        ? `Waiting in Comfy queue (${snap.pendingCount} pending) · ${elapsedS}s`
                        : snap.runningCount > 0
                          ? `ComfyUI running (model / VAE load / sample) · ${elapsedS}s — long silent loads are normal after unload`
                          : `ComfyUI working… ${elapsedS}s (limit ${capMin}m)`,
                    // Don't fake progress to 90% on a timer — stays low during load
                    percent: inQueue
                        ? 8
                        : Math.min(85, 12 + Math.floor(Math.log10(2 + elapsedS) * 18)),
                });
            }
        }

        await new Promise((r) => setTimeout(r, pollMs));
    }
}

/**
 * Normalize a history media entry into { filename, subfolder, type }.
 * Comfy SaveImage uses images[]; SaveVideo/PreviewVideo uses videos[] or video[]
 * with SavedResult dicts: { filename, subfolder, type }.
 */
function normalizeMediaFileInfo(entry) {
    if (entry == null) return null;
    if (typeof entry === 'string') {
        const name = entry.split(/[/\\]/).pop();
        if (!name) return null;
        // prefix path like "video/foo.mp4" → subfolder video
        const parts = entry.replace(/\\/g, '/').split('/');
        const filename = parts.pop();
        const subfolder = parts.join('/');
        return { filename, subfolder, type: 'output' };
    }
    if (typeof entry !== 'object') return null;

    let filename =
        entry.filename ||
        entry.name ||
        entry.file ||
        entry.filename_ ||
        (typeof entry.path === 'string' ? entry.path.split(/[/\\]/).pop() : null);

    if (!filename && typeof entry.url === 'string') {
        try {
            filename = new URL(entry.url, 'http://local').pathname.split('/').pop();
        } catch {
            filename = entry.url.split(/[/\\]/).pop();
        }
    }
    if (!filename || filename === 'undefined') return null;

    let subfolder = entry.subfolder || entry.subdir || entry.directory || '';
    // Some results put folder in filename_prefix path
    if (!subfolder && String(filename).includes('/')) {
        const parts = String(filename).replace(/\\/g, '/').split('/');
        filename = parts.pop();
        subfolder = parts.join('/');
    }

    let type = entry.type || entry.folder_type || 'output';
    // FolderType enum sometimes serialized as number/object
    if (type && typeof type === 'object' && type.value != null) type = type.value;
    if (type === 'FolderType.output' || type === 'OUTPUT') type = 'output';
    if (type === 'FolderType.temp' || type === 'TEMP') type = 'temp';
    if (type === 'FolderType.input' || type === 'INPUT') type = 'input';

    return {
        filename: String(filename),
        subfolder: String(subfolder || ''),
        type: String(type || 'output'),
    };
}

function isVideoFilename(name) {
    return /\.(mp4|webm|mov|mkv|avi|m4v|gif|webp)$/i.test(String(name || ''));
}

async function downloadView(baseUrl, fileInfo) {
    const base = resolveBase(baseUrl);
    const info = normalizeMediaFileInfo(fileInfo);
    if (!info || !info.filename) {
        throw new Error(
            `Failed to download output: missing filename in history entry (${JSON.stringify(fileInfo).slice(0, 200)})`
        );
    }
    const q = new URLSearchParams({
        filename: info.filename,
        subfolder: info.subfolder || '',
        type: info.type || 'output',
    });
    const res = await comfyGet(base, `/view?${q}`, 300000);
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Failed to download output ${info.subfolder ? info.subfolder + '/' : ''}${info.filename} (HTTP ${res.status})`
        );
    }
    return res.buffer;
}

/**
 * Collect downloadable media from a history entry.
 * Handles SaveImage (images[]), SaveVideo / PreviewVideo (videos[] / video[] / gifs[]),
 * and nested ui blobs from newer Comfy API nodes.
 */
function collectOutputs(historyEntry, kind) {
    const images = [];
    const videos = [];

    function consider(keyHint, raw) {
        const info = normalizeMediaFileInfo(raw);
        if (!info) return;
        const key = String(keyHint || '').toLowerCase();
        const asVideo =
            /video|gif|animated|movie|mp4|webm/.test(key) || isVideoFilename(info.filename);
        if (asVideo) videos.push(info);
        else images.push(info);
    }

    function walk(obj, keyHint = '') {
        if (obj == null) return;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (item && typeof item === 'object') {
                    if (
                        item.filename != null ||
                        item.name != null ||
                        item.file != null ||
                        item.path != null
                    ) {
                        consider(keyHint, item);
                    } else {
                        walk(item, keyHint);
                    }
                } else if (typeof item === 'string') {
                    consider(keyHint, item);
                }
            }
            return;
        }
        if (typeof obj !== 'object') return;

        for (const [k, v] of Object.entries(obj)) {
            if (v == null) continue;
            // Known media arrays / nested ui containers
            if (
                /^(images|gifs|videos|video|animated|files|results|preview|media)$/i.test(k) ||
                Array.isArray(v)
            ) {
                walk(v, k);
            } else if (typeof v === 'object' && !Array.isArray(v)) {
                // One level of nesting (node id → { images|videos|… })
                if (
                    v.images ||
                    v.gifs ||
                    v.videos ||
                    v.video ||
                    v.animated ||
                    v.files ||
                    v.ui
                ) {
                    walk(v, k);
                }
            }
        }
    }

    walk(historyEntry.outputs || {});
    // Some builds attach previews on the entry root
    if (historyEntry.ui) walk(historyEntry.ui, 'ui');
    if (historyEntry.meta) walk(historyEntry.meta, 'meta');

    // Dedupe by subfolder/filename/type
    const dedupe = (list) => {
        const seen = new Set();
        const out = [];
        for (const f of list) {
            const key = `${f.type}|${f.subfolder}|${f.filename}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(f);
        }
        return out;
    };

    const imgList = dedupe(images);
    const vidList = dedupe(videos);

    if (kind === 'video') {
        return {
            files: vidList.length ? vidList : imgList,
            preferVideo: vidList.length > 0,
            debug: summarizeOutputShapes(historyEntry),
        };
    }
    return {
        files: imgList.length ? imgList : vidList,
        preferVideo: !imgList.length && vidList.length > 0,
        debug: summarizeOutputShapes(historyEntry),
    };
}

function summarizeOutputShapes(historyEntry) {
    const outputs = historyEntry && historyEntry.outputs;
    if (!outputs || typeof outputs !== 'object') return 'no outputs';
    const parts = [];
    for (const [nodeId, nodeOut] of Object.entries(outputs)) {
        if (!nodeOut || typeof nodeOut !== 'object') {
            parts.push(`${nodeId}:<?>`);
            continue;
        }
        const keys = Object.keys(nodeOut)
            .map((k) => {
                const v = nodeOut[k];
                const n = Array.isArray(v) ? v.length : v && typeof v === 'object' ? '{…}' : typeof v;
                return `${k}(${n})`;
            })
            .join(',');
        parts.push(`${nodeId}:[${keys}]`);
    }
    return parts.join('; ').slice(0, 400);
}

function mimeFromFilename(name, preferVideo) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return preferVideo ? 'image/webp' : 'image/webp';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.mp4')) return 'video/mp4';
    if (n.endsWith('.webm')) return 'video/webm';
    if (n.endsWith('.mov')) return 'video/quicktime';
    return preferVideo ? 'video/mp4' : 'image/png';
}

// ---------------------------------------------------------------------------
// Job progress store + ComfyUI WebSocket
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const jobs = new Map();
const JOB_TTL_MS = 45 * 60 * 1000;

function createJob(kind) {
    const id = crypto.randomUUID();
    const job = {
        id,
        kind: kind || 'image',
        status: 'preparing', // preparing | uploading | queued | running | downloading | done | error
        message: 'Preparing workflow…',
        percent: 0, // 0–100; stages without fine progress still move this
        node: null,
        nodeType: null,
        value: 0,
        max: 0,
        promptId: null,
        clientId: null,
        baseUrl: null,
        error: null,
        result: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        _ws: null,
        _cancelled: false,
    };
    jobs.set(id, job);
    return job;
}

function updateJob(job, patch) {
    if (!job || job._cancelled && patch.status !== 'error' && patch.status !== 'done') {
        // still allow cancel finalization
    }
    Object.assign(job, patch, { updatedAt: Date.now() });
    return job;
}

function publicJob(job) {
    if (!job) return null;
    return {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        message: job.message,
        percent: job.percent,
        node: job.node,
        nodeType: job.nodeType,
        value: job.value,
        max: job.max,
        promptId: job.promptId,
        error: job.error,
        result: job.result,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
    };
}

function cleanupOldJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (now - job.createdAt > JOB_TTL_MS) {
            try {
                if (job._ws) job._ws.close();
            } catch {
                /* ignore */
            }
            jobs.delete(id);
        }
    }
}
setInterval(cleanupOldJobs, 5 * 60 * 1000).unref?.();

/**
 * Open ComfyUI WebSocket and forward progress for our prompt/client.
 * @returns {{ close: () => void }}
 */
function openComfyProgressSocket(baseUrl, clientId, getPromptId, onEvent) {
    if (typeof WebSocket === 'undefined') {
        return { close() {} };
    }
    let ws;
    try {
        const u = new URL(baseUrl);
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${u.host}/ws?clientId=${encodeURIComponent(clientId)}`;
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.warn('  [COMFY] WebSocket open failed:', err.message);
        return { close() {} };
    }

    let closed = false;
    ws.addEventListener('message', (ev) => {
        if (closed) return;
        try {
            const raw = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.();
            if (!raw || raw[0] !== '{') return; // binary previews
            const msg = JSON.parse(raw);
            const type = msg.type;
            const data = msg.data || {};
            const promptId = getPromptId();

            // Filter to our prompt when known
            if (promptId && data.prompt_id && data.prompt_id !== promptId) return;

            if (type === 'execution_start') {
                onEvent({
                    status: 'running',
                    message: 'Execution started…',
                    percent: Math.max(5, data.percent || 5),
                });
            } else if (type === 'executing') {
                // data.node is null when finishing
                if (data.node == null) {
                    onEvent({
                        status: 'running',
                        message: 'Finishing…',
                        node: null,
                        nodeType: null,
                        percent: 95,
                    });
                } else {
                    onEvent({
                        status: 'running',
                        message: `Running node ${data.node}${data.node_type ? ` (${data.node_type})` : ''}…`,
                        node: String(data.node),
                        nodeType: data.node_type || null,
                        percent: undefined, // leave sampler % if set
                    });
                }
            } else if (type === 'progress') {
                const value = Number(data.value) || 0;
                const max = Number(data.max) || 0;
                const pct = max > 0 ? Math.min(99, Math.round((value / max) * 100)) : 0;
                onEvent({
                    status: 'running',
                    message:
                        max > 0
                            ? `Sampling ${value}/${max}${data.node ? ` · node ${data.node}` : ''}`
                            : 'Working…',
                    value,
                    max,
                    percent: pct > 0 ? Math.max(10, pct) : undefined,
                    node: data.node != null ? String(data.node) : undefined,
                });
            } else if (type === 'progress_state') {
                // newer Comfy: nested state map — pick first non-zero
                // ignore if hard to parse
            } else if (type === 'execution_error') {
                const err =
                    data.exception_message ||
                    data.message ||
                    data.exception_type ||
                    'ComfyUI execution error';
                onEvent({
                    status: 'error',
                    message: err,
                    error: err,
                });
            } else if (type === 'execution_success' || type === 'executed') {
                // don't mark done — still need to download outputs
                if (type === 'execution_success') {
                    onEvent({
                        status: 'running',
                        message: 'Execution finished — collecting outputs…',
                        percent: 96,
                    });
                }
            } else if (type === 'status') {
                const exec = data.status && data.status.exec_info;
                if (exec && typeof exec.queue_remaining === 'number' && exec.queue_remaining > 0) {
                    onEvent({
                        message: `In queue (${exec.queue_remaining} remaining)…`,
                        status: 'queued',
                        percent: 3,
                    });
                }
            }
        } catch {
            /* ignore parse errors */
        }
    });

    ws.addEventListener('error', () => {
        /* progress is optional */
    });

    return {
        close() {
            closed = true;
            try {
                ws.close();
            } catch {
                /* ignore */
            }
        },
    };
}

/**
 * Full generation: load workflow, convert, inject, queue, download first output.
 * @param {object} opts
 * @param {(patch: object) => void} [opts.onProgress]
 */
async function generate(opts) {
    const {
        baseUrl: reqBase,
        kind = 'image',
        prompt = '',
        images = [],
        width,
        height,
        templateId,
        customWorkflow,
        includeApiTemplates,
        models,
        /** When false, never rewrite latent width/height (default false for video). */
        applySize,
        onProgress,
        clientId: clientIdOpt,
        /**
         * Unload models + free memory via Comfy /free before queueing.
         * Default true for video (LTX-sized); false for image unless explicitly set.
         */
        freeBeforeRun,
    } = opts;

    const report = (patch) => {
        try {
            if (typeof onProgress === 'function') onProgress(patch);
        } catch {
            /* ignore */
        }
    };

    const base = resolveBase(reqBase);
    report({ status: 'preparing', message: 'Loading workflow…', percent: 2 });

    let apiWf;
    try {
        apiWf = await loadApiWorkflow(base, { templateId, customWorkflow });
    } catch (err) {
        if (!templateId && !customWorkflow) {
            throw new Error(
                'Select a ComfyUI template, a history run, or provide a custom workflow JSON'
            );
        }
        throw err;
    }

    // Strip undefined inputs
    for (const node of Object.values(apiWf)) {
        if (!node.inputs) continue;
        for (const [k, v] of Object.entries(node.inputs)) {
            if (v === undefined) delete node.inputs[k];
        }
    }

    report({ status: 'preparing', message: 'Applying models & prompt…', percent: 5 });
    const modelResult = injectModels(apiWf, models);
    const promptResult = injectPrompt(apiWf, prompt);

    if (images && images.length) {
        report({
            status: 'uploading',
            message: `Uploading ${images.length} reference image(s)…`,
            percent: 8,
        });
    }
    await injectImages(base, apiWf, images);
    injectSeed(apiWf);

    // Size injection is dangerous for video / custom graphs. Only apply when asked,
    // and only to empty-latent style nodes (never every node with width/height).
    const shouldSize =
        applySize === true || (applySize !== false && kind === 'image' && width && height);
    if (shouldSize && width && height) {
        const sizeResult = injectSize(apiWf, width, height);
        if (sizeResult.applied) {
            console.log(`  [COMFY] Size inject ${width}x${height} on ${sizeResult.applied} field(s)`);
        }
    }

    // Combo widgets + known dynamic nodes (ResizeImageMask, LoadImage filenames)
    try {
        const objectInfo = await getObjectInfo(base);
        sanitizeApiWorkflowCombos(apiWf, objectInfo);
        repairKnownNodeInputs(apiWf);
    } catch (err) {
        console.warn('  [COMFY] combo sanitize skipped:', err.message);
        try {
            repairKnownNodeInputs(apiWf);
        } catch {
            /* ignore */
        }
    }

    // Log final loader snapshot (what Comfy will actually try to load)
    try {
        const loaders = [];
        for (const [id, n] of Object.entries(apiWf)) {
            if (!n || !n.class_type) continue;
            if (/loader|unet|checkpoint|lora|vae|ltx/i.test(n.class_type)) {
                const bits = [n.class_type];
                for (const k of [
                    'ckpt_name',
                    'unet_name',
                    'lora_name',
                    'vae_name',
                    'model_name',
                    'clip_name',
                    'type',
                    'weight_dtype',
                ]) {
                    if (n.inputs && n.inputs[k] != null && n.inputs[k] !== '') {
                        bits.push(`${k}=${n.inputs[k]}`);
                    }
                }
                loaders.push(`${id}:{${bits.join(' ')}}`);
            }
        }
        if (loaders.length) {
            console.log(`  [COMFY] Loaders (final): ${loaders.join(' | ').slice(0, 800)}`);
        }
        console.log(`  [COMFY] Queueing ${Object.keys(apiWf).length} nodes (kind=${kind})…`);
    } catch {
        /* ignore */
    }

    // One heavy generate at a time per Comfy host (LTX AV will thrash if stacked)
    return withComfyGenerateLock(base, async () => {
        const clientId = clientIdOpt || crypto.randomUUID();
        let promptId = null;

        // Wait for host idle first, then purge VRAM so /free isn't deferred behind a running job
        const pre = await getComfyQueueSnapshot(base);
        if (pre.runningCount > 0 || pre.pendingCount > 0) {
            console.log(
                `  [COMFY] Host busy before submit: running=${pre.runningCount} pending=${pre.pendingCount}`
            );
            report({
                status: 'queued',
                message: `ComfyUI busy (running=${pre.runningCount}, pending=${pre.pendingCount}) — waiting for a free slot…`,
                percent: 5,
            });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 180000) {
                const snap = await getComfyQueueSnapshot(base);
                if (snap.runningCount === 0 && snap.pendingCount === 0) break;
                report({
                    status: 'queued',
                    message: `Waiting for ComfyUI queue to clear (${snap.runningCount} running, ${snap.pendingCount} pending)…`,
                    percent: 5,
                });
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        // Free VRAM/RAM so the next allocate isn't fighting leftover models (esp. LTX 22B + Gemma)
        const shouldFree =
            freeBeforeRun === true || (freeBeforeRun !== false && kind === 'video');
        if (shouldFree) {
            report({
                status: 'preparing',
                message: 'Freeing ComfyUI VRAM / unloading models…',
                percent: 6,
            });
            try {
                const mem = await freeComfyMemory(base, {
                    unloadModels: true,
                    freeMemory: true,
                });
                const freeV = mem.after && mem.after.vramFree;
                report({
                    status: 'preparing',
                    message: freeV
                        ? `VRAM free after purge: ${formatBytes(freeV)} — submitting…`
                        : 'Memory purge requested — submitting…',
                    percent: 8,
                });
            } catch (err) {
                console.warn('  [COMFY] /free failed (continuing):', err.message);
            }
        }

        const activity = { lastAt: Date.now() };
        const sock = openComfyProgressSocket(base, clientId, () => promptId, (ev) => {
            // Any WS event means the executor is alive — keep the wait loop going
            activity.lastAt = Date.now();
            report(ev);
        });

        try {
            report({ status: 'queued', message: 'Submitting to ComfyUI…', percent: 10 });
            // Small delay so WS handshake completes (progress for load phase)
            await new Promise((r) => setTimeout(r, 150));
            promptId = await queuePrompt(base, apiWf, clientId);
            console.log(`  [COMFY] prompt_id=${promptId}`);
            activity.lastAt = Date.now();
            report({
                status: 'queued',
                message: `Queued (${promptId.slice(0, 8)}…)…`,
                percent: 12,
                promptId,
            });

            const absoluteMaxMs =
                kind === 'video' ? GENERATE_MAX_WAIT_MS : GENERATE_MAX_WAIT_IMAGE_MS;
            const history = await waitForHistory(base, promptId, {
                absoluteMaxMs,
                idleGraceMs: GENERATE_IDLE_GRACE_MS,
                activity,
                onWait: (info) => {
                    if (info && info.message) {
                        report({
                            status: info.status || 'running',
                            message: info.message,
                            percent: info.percent,
                        });
                    }
                },
            });
            const { files, preferVideo, debug } = collectOutputs(history, kind);

            if (!files.length) {
                console.error('  [COMFY] No media parsed from history. shapes:', debug);
                console.error(
                    '  [COMFY] outputs dump:',
                    JSON.stringify(history && history.outputs).slice(0, 1200)
                );
                throw new Error(
                    'ComfyUI finished but produced no downloadable media. ' +
                        'Need a SaveVideo / SaveImage / SaveWEBM (or similar) output node. ' +
                        `History shape: ${debug || 'unknown'}`
                );
            }

            const file = files[files.length - 1];
            report({
                status: 'downloading',
                message: `Downloading ${file.subfolder ? file.subfolder + '/' : ''}${file.filename}…`,
                percent: 97,
            });
            console.log(
                `  [COMFY] Downloading ${file.type}:${file.subfolder}/${file.filename} (${files.length} candidate(s))`
            );
            const buffer = await downloadView(base, file);
            const mime = mimeFromFilename(file.filename, preferVideo || kind === 'video');
            const b64 = buffer.toString('base64');

            report({ status: 'done', message: 'Complete', percent: 100 });

            return {
                mime,
                dataBase64: b64,
                dataUrl: `data:${mime};base64,${b64}`,
                filename: file.filename,
                promptId,
                promptInjected: promptResult.injected,
                modelsApplied: modelResult.applied,
                kind,
                includeApiTemplates: !!includeApiTemplates,
            };
        } finally {
            sock.close();
        }
    });
}

// ---------------------------------------------------------------------------
// Express route registration
// ---------------------------------------------------------------------------

function registerRoutes(app) {
    /**
     * GET /api/comfy/status
     */
    app.get('/api/comfy/status', (_req, res) => {
        res.json(getStatus());
    });

    /**
     * POST /api/comfy/scan  body: { lan?: boolean, autoConnect?: boolean }
     */
    app.post('/api/comfy/scan', async (req, res) => {
        try {
            console.log('  [COMFY] Scanning for ComfyUI instances…');
            const lan = req.body && req.body.lan !== false;
            const autoConnect = !req.body || req.body.autoConnect !== false;
            const found = await scanForComfy({ lan });
            console.log(`  [COMFY] Found ${found.length} instance(s)`);

            let connected = null;
            if (autoConnect && found.length) {
                // Prefer existing base if still in list, else first
                const prefer = state.baseUrl
                    ? found.find((f) => f.baseUrl === state.baseUrl)
                    : null;
                const pick = prefer || found[0];
                connected = await connectComfy(pick.baseUrl);
                console.log(`  [COMFY] Connected → ${connected.baseUrl}`);
            }

            res.json({
                candidates: found.map((f) => ({
                    baseUrl: f.baseUrl,
                    local: f.local,
                    devices: f.systemStats && f.systemStats.devices,
                })),
                connected,
                status: getStatus(),
            });
        } catch (err) {
            console.error('  [COMFY] Scan failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /api/comfy/connect  body: { baseUrl }
     */
    app.post('/api/comfy/connect', async (req, res) => {
        try {
            const baseUrl = req.body && req.body.baseUrl;
            const connected = await connectComfy(baseUrl);
            console.log(`  [COMFY] Manual connect → ${connected.baseUrl}`);
            res.json({ connected, status: getStatus() });
        } catch (err) {
            console.error('  [COMFY] Connect failed:', err.message);
            res.status(400).json({ error: err.message });
        }
    });

    /**
     * POST /api/comfy/disconnect
     */
    app.post('/api/comfy/disconnect', (_req, res) => {
        state.baseUrl = null;
        state.lastSystemStats = null;
        state.objectInfoCache = { baseUrl: null, data: null, at: 0 };
        state.templatesCache = { baseUrl: null, data: null, at: 0 };
        res.json({ status: getStatus() });
    });

    /**
     * POST /api/comfy/test  body: { baseUrl? }
     */
    app.post('/api/comfy/test', async (req, res) => {
        try {
            const base = (req.body && req.body.baseUrl) || state.baseUrl;
            if (!base) return res.status(400).json({ error: 'No base URL' });
            const r = await probeComfy(base);
            if (!r.ok) return res.status(502).json({ error: r.error || 'Unreachable' });
            // Optionally adopt as active
            if (req.body && req.body.connect !== false) {
                await connectComfy(r.baseUrl);
            }
            res.json({ ok: true, baseUrl: r.baseUrl, systemStats: r.systemStats });
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    /**
     * GET /api/comfy/templates?media=image|video&includeApi=0|1&baseUrl=
     */
    app.get('/api/comfy/templates', async (req, res) => {
        try {
            const media = req.query.media === 'video' ? 'video' : 'image';
            const includeApi = req.query.includeApi === '1' || req.query.includeApi === 'true';
            const baseUrl = req.query.baseUrl || undefined;
            const templates = await listTemplates(baseUrl, media, { includeApi });
            res.json({ media, templates, status: getStatus() });
        } catch (err) {
            console.error('  [COMFY] Templates list failed:', err.message);
            res.status(502).json({ error: err.message });
        }
    });

    /**
     * GET /api/comfy/history?media=image|video&max=40&baseUrl=
     * Recent ComfyUI execution history, usable as workflow sources (id: history:<prompt_id>).
     */
    app.get('/api/comfy/history', async (req, res) => {
        try {
            const media = req.query.media === 'video' ? 'video' : 'image';
            const maxItems = Math.min(100, Math.max(1, parseInt(String(req.query.max || '40'), 10) || 40));
            const baseUrl = req.query.baseUrl || undefined;
            const history = await listHistory(baseUrl, { media, maxItems });
            res.json({ media, history, status: getStatus() });
        } catch (err) {
            console.error('  [COMFY] History list failed:', err.message);
            res.status(502).json({ error: err.message });
        }
    });

    /**
     * GET /api/comfy/models — installed checkpoints, loras, etc. on the connected instance.
     */
    app.get('/api/comfy/models', async (req, res) => {
        try {
            const data = await listInstalledModels(req.query.baseUrl || undefined);
            res.json({ ...data, status: getStatus() });
        } catch (err) {
            console.error('  [COMFY] Models list failed:', err.message);
            res.status(502).json({ error: err.message });
        }
    });

    /**
     * POST /api/comfy/inspect-workflow
     * body: { templateId?, customWorkflow? }
     * Returns model loader slots found in the workflow (checkpoints, loras, …).
     */
    app.post('/api/comfy/inspect-workflow', async (req, res) => {
        try {
            const body = req.body || {};
            const baseUrl = req.query.baseUrl || body.baseUrl;
            const apiWf = await loadApiWorkflow(baseUrl, {
                templateId: body.templateId,
                customWorkflow: body.customWorkflow,
            });
            // object_info carries Comfy's per-node filtered model lists (folder + type aware)
            let objectInfo = {};
            try {
                objectInfo = await getObjectInfo(baseUrl);
            } catch (err) {
                console.warn('  [COMFY] object_info unavailable for inspect:', err.message);
            }
            const slots = analyzeWorkflowModels(apiWf, objectInfo);
            const images = analyzeWorkflowImages(apiWf);
            res.json({ ...slots, ...images, status: getStatus() });
        } catch (err) {
            console.error('  [COMFY] Inspect workflow failed:', err.message);
            res.status(502).json({ error: err.message });
        }
    });

    /**
     * GET /api/comfy/templates/:name
     */
    app.get('/api/comfy/templates/:name', async (req, res) => {
        try {
            const name = req.params.name;
            if (String(name).startsWith('history:') || req.query.source === 'history') {
                const wf = await fetchHistoryWorkflow(req.query.baseUrl, name);
                return res.json(wf);
            }
            const wf = await fetchTemplateWorkflow(req.query.baseUrl, name);
            res.json(wf);
        } catch (err) {
            res.status(404).json({ error: err.message });
        }
    });

    /**
     * POST /api/comfy/generate
     * body: {
     *   kind: 'image'|'video',
     *   prompt, images?: [{label,data}],
     *   width?, height?,
     *   templateId?, customWorkflow?,
     *   baseUrl?
     * }
     */
    /**
     * POST /api/comfy/generate
     * Default: async job { jobId } — poll GET /api/comfy/job/:jobId for progress + result.
     * body.async === false → legacy blocking response with image/video data.
     */
    app.post('/api/comfy/generate', async (req, res) => {
        const body = req.body || {};
        const kind = body.kind === 'video' ? 'video' : 'image';
        const useAsync = body.async !== false;

        const genOpts = {
            baseUrl: body.baseUrl,
            kind,
            prompt: body.prompt || '',
            images: body.images || [],
            width: body.width,
            height: body.height,
            applySize: body.applySize != null ? !!body.applySize : kind === 'image',
            templateId: body.templateId,
            customWorkflow: body.customWorkflow,
            models: body.models,
            // Default: purge before video; image opts in via freeBeforeRun
            freeBeforeRun:
                body.freeBeforeRun != null
                    ? !!body.freeBeforeRun
                    : kind === 'video'
                      ? true
                      : false,
        };

        console.log(
            `  [COMFY] Generate ${kind} template=${body.templateId || 'custom'} async=${useAsync}…`
        );

        if (!useAsync) {
            try {
                const result = await generate(genOpts);
                console.log(
                    `  [COMFY] Done prompt_id=${result.promptId} mime=${result.mime} (${Math.round(result.dataBase64.length / 1024)} KB b64)`
                );
                return res.json({
                    mime: result.mime,
                    data: result.dataBase64,
                    dataUrl: result.dataUrl,
                    filename: result.filename,
                    promptId: result.promptId,
                    promptInjected: result.promptInjected,
                });
            } catch (err) {
                const msg =
                    err && err.message
                        ? err.message
                        : formatComfyError(err, 'ComfyUI generation failed');
                console.error('  [COMFY] Generate failed:', msg);
                return res.status(502).json({ error: msg });
            }
        }

        // Async job with live progress
        const job = createJob(kind);
        try {
            job.baseUrl = resolveBase(body.baseUrl);
        } catch {
            job.baseUrl = state.baseUrl;
        }
        res.json({ jobId: job.id, async: true, status: publicJob(job) });

        const clientId = crypto.randomUUID();
        job.clientId = clientId;

        (async () => {
            try {
                const result = await generate({
                    ...genOpts,
                    clientId,
                    onProgress: (patch) => {
                        if (job._cancelled) return;
                        const next = { ...patch };
                        // Don't let WS "error" status clobber until we throw
                        if (next.status === 'error' && next.error) {
                            updateJob(job, {
                                status: 'error',
                                error: next.error,
                                message: next.message || next.error,
                                percent: job.percent,
                            });
                            return;
                        }
                        if (next.percent == null) delete next.percent;
                        if (next.status == null) delete next.status;
                        // Merge carefully
                        updateJob(job, {
                            ...next,
                            percent:
                                next.percent != null
                                    ? next.percent
                                    : job.percent,
                            message: next.message || job.message,
                            status: next.status || job.status,
                            promptId: next.promptId || job.promptId,
                        });
                    },
                });

                if (job._cancelled) {
                    updateJob(job, {
                        status: 'error',
                        error: 'Cancelled',
                        message: 'Cancelled',
                    });
                    return;
                }

                updateJob(job, {
                    status: 'done',
                    message: 'Complete',
                    percent: 100,
                    promptId: result.promptId,
                    result: {
                        mime: result.mime,
                        data: result.dataBase64,
                        dataUrl: result.dataUrl,
                        filename: result.filename,
                        promptId: result.promptId,
                        promptInjected: result.promptInjected,
                    },
                });
                console.log(
                    `  [COMFY] Job ${job.id.slice(0, 8)} done prompt_id=${result.promptId} mime=${result.mime}`
                );
            } catch (err) {
                const msg =
                    err && err.message
                        ? err.message
                        : formatComfyError(err, 'ComfyUI generation failed');
                console.error(`  [COMFY] Job ${job.id.slice(0, 8)} failed:`, msg);
                updateJob(job, {
                    status: 'error',
                    error: msg,
                    message: msg,
                });
            }
        })();
    });

    /**
     * GET /api/comfy/job/:jobId — poll progress / result
     */
    app.get('/api/comfy/job/:jobId', (req, res) => {
        const job = jobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Unknown or expired job' });
        res.json(publicJob(job));
    });

    /**
     * POST /api/comfy/job/:jobId/cancel — interrupt Comfy + mark job cancelled
     */
    app.post('/api/comfy/job/:jobId/cancel', async (req, res) => {
        const job = jobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Unknown or expired job' });
        job._cancelled = true;
        updateJob(job, {
            status: 'error',
            error: 'Cancelled',
            message: 'Cancelled',
        });
        try {
            const base = job.baseUrl || state.baseUrl;
            if (base) {
                await comfyPostJson(base, '/interrupt', {}, 10000);
            }
        } catch (err) {
            console.warn('  [COMFY] interrupt failed:', err.message);
        }
        res.json({ ok: true, status: publicJob(job) });
    });

    // Background: gentle localhost-only auto-scan on boot (non-blocking)
    setTimeout(() => {
        scanForComfy({ lan: false })
            .then((found) => {
                if (found.length && !state.baseUrl) {
                    return connectComfy(found[0].baseUrl).then((c) => {
                        console.log(`  [COMFY] Auto-connected on boot → ${c.baseUrl}`);
                    });
                }
                if (found.length) {
                    console.log(`  [COMFY] Boot scan found ${found.length} (already connected)`);
                } else {
                    console.log('  [COMFY] Boot scan: no local ComfyUI on common ports');
                }
            })
            .catch((err) => console.warn('  [COMFY] Boot scan error:', err.message));
    }, 1500);
}

module.exports = {
    registerRoutes,
    normalizeBaseUrl,
    scanForComfy,
    connectComfy,
    getStatus,
    generate,
    listTemplates,
    listHistory,
    listInstalledModels,
    analyzeWorkflowModels,
    analyzeWorkflowImages,
    injectModels,
    injectImages,
    convertUiToApi,
    flattenSubgraphs,
    isApiFormatWorkflow,
    formatComfyError,
    normalizeWorkflowRaw,
    injectSize,
    sanitizeApiWorkflowCombos,
    repairKnownNodeInputs,
    collectOutputs,
    normalizeMediaFileInfo,
};
