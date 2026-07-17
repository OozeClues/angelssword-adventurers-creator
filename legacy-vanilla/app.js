/**
 * ⚔️ AS Adventurer — Main App Controller
 * Angel's Sword Studios
 * 
 * Tab switching, settings management, toast notifications,
 * notification sounds, keyboard shortcuts, shared utilities.
 */

// ============================================
// GLOBAL STATE
// ============================================
window.ASAdventurer = {
    characterName: '',
    // Shared data passed between tabs
    handoff: {
        spriteCanvas: null,      // Canvas data from Sprite Prep
        spriteBlob: null,        // Sprite as Blob
        spriteBase64: null,      // Sprite as base64
        videoBlob: null,         // Video from Generate Video
        videoUrl: null,          // Object URL for video
        videoPrepData: null,     // Prepared video data from Video Prep
        keyColor: '#00FF00',     // Selected key color (flows through pipeline)
    }
};

// ============================================
// NOTIFICATION SOUND SYSTEM
// ============================================
class NotificationSound {
    constructor() {
        this.audioContext = null;
        this.buffers = {};
        this.enabled = localStorage.getItem('as_sound_enabled') !== 'false';
        this.clips = ['quest_complete_2.mp3', 'quest_complete_10.mp3'];
        this._initOnGesture();
    }

    _initOnGesture() {
        const handler = () => {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                this._preload();
            } else if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
            document.removeEventListener('click', handler);
            document.removeEventListener('keydown', handler);
        };
        document.addEventListener('click', handler);
        document.addEventListener('keydown', handler);
    }

    async _preload() {
        for (const clip of this.clips) {
            try {
                const resp = await fetch(`assets/sounds/${clip}`);
                const buf = await resp.arrayBuffer();
                this.buffers[clip] = await this.audioContext.decodeAudioData(buf);
            } catch (e) {
                console.warn(`[Sound] Failed to preload ${clip}:`, e.message);
            }
        }
        console.log(`[Sound] Preloaded ${Object.keys(this.buffers).length} clips`);
    }

    play() {
        if (!this.enabled || !this.audioContext) return;

        // Pick random clip
        const clip = this.clips[Math.floor(Math.random() * this.clips.length)];
        const buffer = this.buffers[clip];
        if (!buffer) return;

        const source = this.audioContext.createBufferSource();
        const gain = this.audioContext.createGain();
        gain.gain.value = 0.7;
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(this.audioContext.destination);
        source.start(0);

        // System notification if tab is hidden
        if (document.hidden && Notification.permission === 'granted') {
            new Notification('⚔️ Quest Complete!', {
                body: 'Your generation has finished!',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚔️</text></svg>'
            });
        }
    }

    setEnabled(val) {
        this.enabled = val;
        localStorage.setItem('as_sound_enabled', val);
    }
}

window.notificationSound = new NotificationSound();

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove
    setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('exit');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

window.showToast = showToast;

// ============================================
// UTILITY FUNCTIONS
// ============================================
function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

function base64ToBlob(base64, mimeType = 'image/png') {
    const raw = base64.includes(',') ? base64.split(',')[1] : base64;
    const bytes = atob(raw);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mimeType });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
}

function colorName(hex) {
    const names = {
        '#00FF00': 'Green', '#FF00FF': 'Magenta', '#0000FF': 'Blue',
        '#FFFF00': 'Yellow', '#00FFFF': 'Cyan'
    };
    return names[hex.toUpperCase()] || hex;
}

window.debounce = debounce;
window.base64ToBlob = base64ToBlob;
window.blobToBase64 = blobToBase64;
window.hexToRgb = hexToRgb;
window.colorName = colorName;

// ============================================
// TAB SWITCHING
// ============================================
function initTabs() {
    const tabBar = document.getElementById('tabBar');
    const pipelineSteps = document.getElementById('pipelineSteps');

    function switchTab(tabId) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Update tab panels
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === tabId);
        });

        // Update pipeline steps
        document.querySelectorAll('.pipeline-steps .step').forEach(step => {
            step.classList.toggle('active', step.dataset.tab === tabId);
        });
    }

    // Tab bar clicks
    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (btn) switchTab(btn.dataset.tab);
    });

    // Pipeline step clicks
    pipelineSteps.addEventListener('click', (e) => {
        const step = e.target.closest('.step');
        if (step && step.dataset.tab) switchTab(step.dataset.tab);
    });

    window.switchTab = switchTab;
}

// ============================================
// SETTINGS
// ============================================
function initSettings() {
    // --- OpenAI Key ---
    const openaiInput = document.getElementById('settingsOpenAIKey');
    const openaiToggle = document.getElementById('settingsOpenAIToggle');
    const openaiSave = document.getElementById('settingsOpenAISave');
    const openaiTest = document.getElementById('settingsOpenAITest');
    const openaiStatus = document.getElementById('settingsOpenAIStatus');

    // Load saved key
    const savedOpenAI = localStorage.getItem('openai_api_key');
    if (savedOpenAI) openaiInput.value = savedOpenAI;

    // Show/hide toggle
    openaiToggle.addEventListener('click', () => {
        const isPassword = openaiInput.type === 'password';
        openaiInput.type = isPassword ? 'text' : 'password';
        openaiToggle.textContent = isPassword ? '🙈' : '👁️';
    });

    // Save
    openaiSave.addEventListener('click', () => {
        const key = openaiInput.value.trim();
        if (key) {
            localStorage.setItem('openai_api_key', key);
            showToast('OpenAI API key saved', 'success');
        } else {
            localStorage.removeItem('openai_api_key');
            showToast('OpenAI API key removed', 'warning');
        }
    });

    // Test connection
    openaiTest.addEventListener('click', async () => {
        const key = openaiInput.value.trim();
        if (!key) {
            openaiStatus.innerHTML = '<div class="status-msg error">Enter an API key first</div>';
            return;
        }

        openaiStatus.innerHTML = '<div class="status-msg info"><span class="spinner"></span> Testing connection...</div>';

        try {
            const resp = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: 'Say "connected" in one word.' }],
                    max_tokens: 5
                })
            });

            if (resp.ok) {
                openaiStatus.innerHTML = '<div class="status-msg success">✅ Connection successful!</div>';
                // Auto-save on successful test
                localStorage.setItem('openai_api_key', key);
            } else {
                const data = await resp.json().catch(() => ({}));
                const msg = data?.error?.message || `HTTP ${resp.status}`;
                openaiStatus.innerHTML = `<div class="status-msg error">❌ ${msg}</div>`;
            }
        } catch (err) {
            openaiStatus.innerHTML = `<div class="status-msg error">❌ ${err.message}. Is the server running?</div>`;
        }
    });

    // --- Google Key ---
    const googleInput = document.getElementById('settingsGoogleKey');
    const googleToggle = document.getElementById('settingsGoogleToggle');
    const googleSave = document.getElementById('settingsGoogleSave');
    const googleTest = document.getElementById('settingsGoogleTest');
    const googleStatus = document.getElementById('settingsGoogleStatus');

    // Load saved key
    const savedGoogle = localStorage.getItem('google_api_key');
    if (savedGoogle) googleInput.value = savedGoogle;

    // Show/hide toggle
    googleToggle.addEventListener('click', () => {
        const isPassword = googleInput.type === 'password';
        googleInput.type = isPassword ? 'text' : 'password';
        googleToggle.textContent = isPassword ? '🙈' : '👁️';
    });

    // Save
    googleSave.addEventListener('click', () => {
        const key = googleInput.value.trim();
        if (key) {
            localStorage.setItem('google_api_key', key);
            showToast('Google API key saved', 'success');
        } else {
            localStorage.removeItem('google_api_key');
            showToast('Google API key removed', 'warning');
        }
    });

    // Test connection
    googleTest.addEventListener('click', async () => {
        const key = googleInput.value.trim();
        if (!key) {
            googleStatus.innerHTML = '<div class="status-msg error">Enter an API key first</div>';
            return;
        }

        googleStatus.innerHTML = '<div class="status-msg info"><span class="spinner"></span> Testing connection...</div>';

        try {
            // Simple test: list models
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            if (resp.ok) {
                googleStatus.innerHTML = '<div class="status-msg success">✅ Connection successful!</div>';
                localStorage.setItem('google_api_key', key);
            } else {
                const data = await resp.json().catch(() => ({}));
                const msg = data?.error?.message || `HTTP ${resp.status}`;
                googleStatus.innerHTML = `<div class="status-msg error">❌ ${msg}</div>`;
            }
        } catch (err) {
            googleStatus.innerHTML = `<div class="status-msg error">❌ ${err.message}</div>`;
        }
    });

    // --- Notification Sounds ---
    const soundToggle = document.getElementById('settingsSoundEnabled');
    const soundTest = document.getElementById('settingsSoundTest');

    soundToggle.checked = window.notificationSound.enabled;
    soundToggle.addEventListener('change', () => {
        window.notificationSound.setEnabled(soundToggle.checked);
    });

    soundTest.addEventListener('click', () => {
        window.notificationSound.play();
    });

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        // Don't capture when typing in inputs
        if (e.target.matches('input, textarea, select')) return;

        if (e.key === 'Escape') {
            // Cancel any active operation
            document.querySelectorAll('[id$="CancelBtn"]').forEach(btn => {
                if (btn.offsetParent !== null) btn.click();
            });
        }

        // Arrow keys — delegate to active tab's frame navigation
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const activePanel = document.querySelector('.tab-panel.active');
            if (!activePanel) return;

            // Video Prep frame navigation
            if (activePanel.id === 'tab-video-prep') {
                e.preventDefault();
                const btn = e.key === 'ArrowLeft' ? 
                    document.getElementById('vpPrevFrame') : 
                    document.getElementById('vpNextFrame');
                if (btn) btn.click();
            }

            // Model Exporter frame navigation
            if (activePanel.id === 'tab-exporter') {
                e.preventDefault();
                const btn = e.key === 'ArrowLeft' ? 
                    document.getElementById('exPrevFrame') : 
                    document.getElementById('exNextFrame');
                if (btn) btn.click();
            }
        }
    });
}

// ============================================
// GENERIC UI HELPERS
// ============================================

/** Initialize color swatch selection for a container */
function initColorSwatches(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('click', (e) => {
        const swatch = e.target.closest('.color-swatch');
        if (!swatch) return;

        container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');

        const color = swatch.dataset.color;
        if (onChange) onChange(color);
    });

    // Return getter
    return () => {
        const selected = container.querySelector('.color-swatch.selected');
        return selected ? selected.dataset.color : '#00FF00';
    };
}

/** Initialize mode selector buttons */
function initModeSelector(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.mode-btn, .seg-btn, .export-mode-btn');
        if (!btn) return;

        container.querySelectorAll('.mode-btn, .seg-btn, .export-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const mode = btn.dataset.mode || btn.dataset.ratio;
        if (onChange) onChange(mode);
    });
}

/** Initialize generation count selector */
function initGenCount(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.gen-count-btn');
        if (!btn) return;
        container.querySelectorAll('.gen-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });

    return () => {
        const active = container.querySelector('.gen-count-btn.active');
        return active ? parseInt(active.dataset.count) : 1;
    };
}

/** Initialize a range slider with live value display */
function initRange(sliderId, displayId, suffix = '', transform = null) {
    const slider = document.getElementById(sliderId);
    const display = document.getElementById(displayId);
    if (!slider || !display) return;

    const update = () => {
        const val = transform ? transform(slider.value) : slider.value;
        display.textContent = val + suffix;
    };

    slider.addEventListener('input', update);
    update(); // initial
    return slider;
}

/** Setup drag-and-drop on an upload zone */
function initUploadZone(zoneId, inputId, onFile, onClear) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    if (!zone || !input) return;

    // Inject clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'upload-clear-btn';
    clearBtn.title = 'Clear';
    clearBtn.innerHTML = '✕';
    clearBtn.type = 'button';
    zone.appendChild(clearBtn);

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        input.value = '';
        zone.classList.remove('has-content');
        if (onClear) onClear();
    });

    // Drag events
    ['dragenter', 'dragover'].forEach(evt => {
        zone.addEventListener(evt, (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
        });
    });

    zone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            zone.classList.add('has-content');
            onFile(files);
        }
    });

    input.addEventListener('change', () => {
        if (input.files.length > 0) {
            zone.classList.add('has-content');
            onFile(input.files);
        }
    });
}

/** Mark an upload zone as having content (shows clear button) */
function markZoneLoaded(zoneId) {
    document.getElementById(zoneId)?.classList.add('has-content');
}

/** Mark an upload zone as empty (hides clear button) */
function markZoneEmpty(zoneId) {
    document.getElementById(zoneId)?.classList.remove('has-content');
}

window.initColorSwatches = initColorSwatches;
window.initModeSelector = initModeSelector;
window.initGenCount = initGenCount;
window.initRange = initRange;
window.initUploadZone = initUploadZone;
window.markZoneLoaded = markZoneLoaded;
window.markZoneEmpty = markZoneEmpty;

// ============================================
// CHARACTER NAME SYNC
// ============================================
function initCharNameSync() {
    // Sync character name across tabs
    const inputs = ['spCharName', 'sgCharName'];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                window.ASAdventurer.characterName = el.value;
                // Sync to other inputs
                inputs.forEach(otherId => {
                    if (otherId !== id) {
                        const other = document.getElementById(otherId);
                        if (other) other.value = el.value;
                    }
                });
            });
        }
    });

    // Load saved name
    const saved = localStorage.getItem('as_char_name');
    if (saved) {
        window.ASAdventurer.characterName = saved;
        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = saved;
        });
    }
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSettings();
    initKeyboard();
    initCharNameSync();
    console.log('⚔️ AS Adventurer initialized');
});
