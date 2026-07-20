import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';
import {
  XaiOAuthService,
  type XaiOAuthLoginProgress,
} from '../../core/xai-oauth.service';
import type { XaiBackend } from '../../core/gen-providers';
import { UploadZoneComponent } from '../../shared/components/upload-zone.component';
import {
  probeExportAcceleration,
  type ExportAccelProbe,
} from '../exporter/chroma-backend';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, UploadZoneComponent],
  template: `
    <div class="settings-section settings-two-col">
      <div class="settings-col settings-col-left">
      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">🤖</span> OpenAI API Key</div>
        <div class="panel-subtitle">
          Required for GPT Image 2 sprite generation. Your key is stored locally and never sent to any third party.
        </div>
        <div class="api-key-row">
          <div class="input-password">
            <input
              [type]="showOpenAI() ? 'text' : 'password'"
              [(ngModel)]="openaiDraft"
              placeholder="sk-..."
              title="Your OpenAI API key"
            />
            <button type="button" class="toggle-vis" title="Show/hide key" (click)="showOpenAI.set(!showOpenAI())">
              {{ showOpenAI() ? '🙈' : '👁️' }}
            </button>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" (click)="saveOpenAI()">Save</button>
          <button type="button" class="btn btn-sm btn-accent" (click)="testOpenAI()">Test</button>
          <a
            class="btn btn-sm btn-secondary"
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            title="Open OpenAI API keys page in a new tab"
          >
            🔗 Get API Key
          </a>
        </div>
        @if (openaiStatus()) {
          <div class="status-msg" [class]="openaiStatus()!.type">{{ openaiStatus()!.text }}</div>
        }
      </div>

      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">🎬</span> Google Gemini API Key</div>
        <div class="panel-subtitle">
          Required for Gemini image + video generation (Omni Flash / Nano Banana). Your key is stored locally and never
          sent to any third party.
        </div>
        <div class="api-key-row">
          <div class="input-password">
            <input
              [type]="showGoogle() ? 'text' : 'password'"
              [(ngModel)]="googleDraft"
              placeholder="AIza..."
              title="Your Google Gemini API key"
            />
            <button type="button" class="toggle-vis" title="Show/hide key" (click)="showGoogle.set(!showGoogle())">
              {{ showGoogle() ? '🙈' : '👁️' }}
            </button>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" (click)="saveGoogle()">Save</button>
          <button type="button" class="btn btn-sm btn-accent" (click)="testGoogle()">Test</button>
          <a
            class="btn btn-sm btn-secondary"
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            title="Open Google AI Studio API keys page in a new tab"
          >
            🔗 Get API Key
          </a>
        </div>
        @if (googleStatus()) {
          <div class="status-msg" [class]="googleStatus()!.type">{{ googleStatus()!.text }}</div>
        }
      </div>

      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">🔊</span> Notifications</div>
        <div class="flex items-center gap-sm">
          <label class="toggle-switch" title="Play a sound when AI generation completes">
            <input
              type="checkbox"
              [checked]="settings.soundEnabled()"
              (change)="onSoundToggle($event)"
            />
            <span class="slider"></span>
          </label>
          <label style="margin-bottom:0">Play sound on generation complete</label>
          <button type="button" class="btn btn-sm btn-secondary" style="margin-left:auto" (click)="sound.play()">
            🔊 Test
          </button>
        </div>
      </div>

      <div class="glass-panel">
        <div class="about-section">
          <div class="about-icon">⚔️</div>
          <div class="about-title">Angel's Sword Studios</div>
          <div class="about-tagline">AS Adventurer Creator — VTuber Creation Pipeline</div>
          <div class="about-tagline">Design → Generate → Prepare → Export</div>
          <hr class="gold-divider" />
          <div class="about-motto">Crafted with ✦ for adventurers everywhere</div>
          <div class="product-links">
            <a href="https://www.angelssword.com" target="_blank" rel="noopener">angelssword.com</a>
            <a href="https://rpg.angelssword.com" target="_blank" rel="noopener">rpg.angelssword.com</a>
            <a href="https://clio.angelssword.com" target="_blank" rel="noopener">clio.angelssword.com</a>
          </div>
        </div>
      </div>

      <div class="glass-panel">
        <div class="panel-title">
          <span class="title-icon">⚡</span> Preview &amp; export
          @if (!accelChecking()) {
            <button
              type="button"
              class="btn btn-sm btn-secondary accel-refresh-btn"
              title="Re-check WebGPU availability"
              (click)="refreshAccel()"
            >
              ↻ Re-check GPU
            </button>
          }
        </div>
        <div class="panel-subtitle">
          Preview controls interactive scrubbing on the Export tab. Export mode chooses how Adventurer
          WebM is keyed in the browser (CPU workers or WebGPU) before server ffmpeg packs the WebM.
        </div>

        <div class="form-row mt-1">
          <label>Preview mode</label>
          <div class="mode-selector" role="group" aria-label="Preview chroma mode">
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.previewAccelMode() === 'auto'"
              title="Use WebGPU for half-res scrub keying when available"
              (click)="setPreviewAccel('auto')"
            >
              Auto (WebGPU)
            </button>
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.previewAccelMode() === 'cpu'"
              title="Force CPU chroma for scrubbing / preview"
              (click)="setPreviewAccel('cpu')"
            >
              CPU only
            </button>
          </div>
        </div>

        <div class="form-row mt-1">
          <label>Export mode (Adventurer WebM)</label>
          <div class="mode-selector" role="group" aria-label="Export pipeline mode">
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.exportPipelineMode() === 'cpu'"
              title="Known-good: browser workers + PNG frames + server ffmpeg"
              (click)="setExportPipeline('cpu')"
            >
              CPU
            </button>
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.exportPipelineMode() === 'gpu'"
              [disabled]="!webgpuExportAvailable()"
              title="Browser WebGPU key + raw RGBA upload + server ffmpeg"
              (click)="setExportPipeline('gpu')"
            >
              GPU
            </button>
          </div>
          <div class="text-dim mt-1" style="font-size: 0.75rem">
            <strong>CPU</strong> — reliable browser workers + PNG frames + server ffmpeg.
            <strong>GPU</strong> — WebGPU keying + raw frames (disabled if WebGPU unavailable).
          </div>
        </div>

        <div
          class="accel-badge accel-badge-panel"
          [class.accel-webgpu]="accel()?.backend === 'webgpu' && settings.previewAccelMode() !== 'cpu'"
          [class.accel-cpu]="accel()?.backend === 'cpu' || settings.previewAccelMode() === 'cpu'"
          [class.accel-checking]="accelChecking()"
          role="status"
          aria-live="polite"
        >
          <span class="accel-icon" aria-hidden="true">
            @if (accelChecking()) {
              ⏳
            } @else if (accel()?.backend === 'webgpu' && settings.previewAccelMode() !== 'cpu') {
              ⚡
            } @else {
              🖥️
            }
          </span>
          <div class="accel-text">
            <div class="accel-title-row">
              <span class="accel-label">WebGPU status</span>
              <span class="accel-pill">
                @if (accelChecking()) {
                  Checking…
                } @else {
                  {{ accel()!.label }}
                }
              </span>
              @if (accel()?.stage && !accelChecking()) {
                <span class="accel-stage">stage: {{ accel()!.stage }}</span>
              }
            </div>
            <div class="accel-summary">
              @if (accelChecking()) {
                Probing WebGPU…
              } @else if (accel()?.backend === 'webgpu') {
                {{ accel()!.summary }}
                @if (accelAdapterLine()) {
                  <span class="accel-adapter"> · {{ accelAdapterLine() }}</span>
                }
              } @else {
                {{ accel()!.summary }}
              }
            </div>
            @if (accel() && !accelChecking()) {
              <div class="accel-detail">{{ accel()!.detail }}</div>
              @if (accel()?.reason) {
                <div class="accel-fail-reason">
                  <strong>Note:</strong> {{ accel()!.reason }}
                </div>
              }
              <ul class="accel-diag">
                <li>
                  <span class="diag-k">navigator.gpu</span>
                  <span class="diag-v" [class.diag-ok]="accel()!.apiPresent" [class.diag-bad]="accel()!.apiPresent === false">
                    {{ accel()!.apiPresent ? 'present' : 'missing' }}
                  </span>
                </li>
                <li>
                  <span class="diag-k">Adapter</span>
                  <span class="diag-v" [class.diag-ok]="!!accelAdapterLine()" [class.diag-bad]="!accelAdapterLine()">
                    {{ accelAdapterLine() || 'none' }}
                  </span>
                </li>
                <li>
                  <span class="diag-k">Export mode</span>
                  <span class="diag-v">{{ settings.exportPipelineMode() }}</span>
                </li>
                <li>
                  <span class="diag-k">Preview mode</span>
                  <span class="diag-v">{{ settings.previewAccelMode() }}</span>
                </li>
              </ul>
            }
          </div>
        </div>
      </div>

      <div class="settings-info">
        <span class="info-icon">🔒</span>
        <strong>Privacy:</strong> Your API keys and SuperGrok OAuth tokens are stored in your browser's localStorage
        only. They are never sent to any server except the official OpenAI, Google, and xAI (auth.x.ai / api.x.ai)
        endpoints, via the local proxy server running on your machine. Local ComfyUI traffic stays on your LAN through
        the same proxy.
      </div>
      </div><!-- /.settings-col-left -->

      <div class="settings-col settings-col-right">
      <!-- Grok Imagine: dual backend (API key | SuperGrok OAuth) -->
      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">⚡</span> Grok Imagine</div>
        <div class="panel-subtitle">
          Use Grok Imagine for image + video via an <strong>xAI API key</strong> or your
          <strong>SuperGrok / X Premium+</strong> subscription. Both can be configured; the master toggle chooses which
          backend every Grok generation uses.
        </div>

        <div class="form-row mt-1">
          <label>Active Grok backend</label>
          <div class="mode-selector" role="group" aria-label="Grok backend">
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.xaiBackend() === 'api_key'"
              title="Use console.x.ai API key for Grok Imagine"
              (click)="setXaiBackend('api_key')"
            >
              🔑 API Key
            </button>
            <button
              type="button"
              class="mode-btn"
              [class.active]="settings.xaiBackend() === 'oauth'"
              title="Use SuperGrok / X Premium+ OAuth for Grok Imagine"
              (click)="setXaiBackend('oauth')"
            >
              ✨ SuperGrok (OAuth)
            </button>
          </div>
          <div class="status-msg info mt-1" style="margin-bottom: 0">
            Active backend: <strong>{{ settings.xaiBackendLabel() }}</strong>
            @if (settings.xaiReady()) {
              · ready
            } @else {
              · not configured
            }
          </div>
        </div>

        <hr class="gold-divider" />

        <!-- API Key subsection -->
        <div [class.xai-backend-inactive]="settings.xaiBackend() !== 'api_key'">
          <div class="panel-title" style="font-size: 0.95rem">
            <span class="title-icon">🔑</span> xAI API Key
            @if (settings.xaiBackend() === 'api_key') {
              <span class="text-gold" style="font-size: 0.7rem; font-weight: 500; margin-left: 0.35rem">ACTIVE</span>
            }
          </div>
          <div class="panel-subtitle">
            Create a key in the xAI console — stored locally only. Used when the backend toggle is set to API Key.
          </div>
          <div class="api-key-row">
            <div class="input-password">
              <input
                [type]="showXai() ? 'text' : 'password'"
                [(ngModel)]="xaiDraft"
                placeholder="xai-..."
                title="Your xAI Grok API key"
              />
              <button type="button" class="toggle-vis" title="Show/hide key" (click)="showXai.set(!showXai())">
                {{ showXai() ? '🙈' : '👁️' }}
              </button>
            </div>
            <button type="button" class="btn btn-sm btn-secondary" (click)="saveXai()">Save</button>
            <button type="button" class="btn btn-sm btn-accent" (click)="testXaiKey()">Test</button>
            <a
              class="btn btn-sm btn-secondary"
              href="https://console.x.ai/team/default/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              title="Open xAI console API keys page"
            >
              🔗 Get API Key
            </a>
          </div>
          @if (xaiStatus()) {
            <div class="status-msg" [class]="xaiStatus()!.type">{{ xaiStatus()!.text }}</div>
          }
        </div>

        <hr class="gold-divider" />

        <!-- SuperGrok OAuth subsection -->
        <div [class.xai-backend-inactive]="settings.xaiBackend() !== 'oauth'">
          <div class="panel-title" style="font-size: 0.95rem">
            <span class="title-icon">✨</span> SuperGrok OAuth
            @if (settings.xaiBackend() === 'oauth') {
              <span class="text-gold" style="font-size: 0.7rem; font-weight: 500; margin-left: 0.35rem">ACTIVE</span>
            }
          </div>
          <div class="panel-subtitle">
            Log in with SuperGrok or X Premium+ — no separate xAI API key required. Tokens stay on this machine and only
            go to auth.x.ai / api.x.ai via the local proxy.
          </div>

          @if (oauthLoginPhase() === 'idle' && !oauthStatus().loggedIn) {
            <button type="button" class="btn-handoff" (click)="startOAuthLogin()">🔐 Login with SuperGrok</button>
            <div class="text-dim mt-1" style="font-size: 0.75rem">
              Opens a verification page. Approve with the X / SuperGrok account that has your subscription.
            </div>
          }

          @if (oauthLoginPhase() === 'progress') {
            <div class="status-msg info">
              <span class="spinner"></span>
              {{ oauthProgressMsg() }}
            </div>
            @if (oauthDeviceCode()) {
              <div class="glass-panel grok-device-code-box mt-1">
                <div class="text-gold" style="font-weight: 600; margin-bottom: 0.25rem">Device Code</div>
                <div class="text-mono" style="font-size: 1.25rem; letter-spacing: 0.1em">
                  {{ oauthDeviceCode() }}
                </div>
                @if (oauthVerifyUrl()) {
                  <div class="mt-1">
                    <a
                      class="btn btn-sm btn-primary"
                      [href]="oauthVerifyUrl()"
                      target="_blank"
                      rel="noopener noreferrer"
                      style="text-decoration: none"
                    >
                      Open Verification Page →
                    </a>
                  </div>
                }
                <div class="text-dim mt-1" style="font-size: 0.7rem">
                  Or visit the link and enter the code above.
                </div>
              </div>
            }
            <button type="button" class="btn btn-sm btn-danger mt-1" (click)="cancelOAuthLogin()">
              Cancel Login
            </button>
          }

          @if (oauthStatus().loggedIn && oauthLoginPhase() === 'idle') {
            <div class="status-msg success">✅ SuperGrok session active</div>
            <div class="flex items-center gap-sm mt-1" style="flex-wrap: wrap">
              <button type="button" class="btn btn-sm btn-accent" (click)="testOAuth()">Test Connection</button>
              <button type="button" class="btn btn-sm btn-secondary" (click)="refreshOAuth()">Refresh Token</button>
              <button type="button" class="btn btn-sm btn-danger" (click)="logoutOAuth()">Logout</button>
            </div>
            @if (oauthExpiresText()) {
              <div class="text-mono text-dim mt-1" style="font-size: 0.7rem">{{ oauthExpiresText() }}</div>
            }
          }

          @if (oauthStatusMsg()) {
            <div class="status-msg" [class]="oauthStatusMsg()!.type">{{ oauthStatusMsg()!.text }}</div>
          }
        </div>
      </div>

      <!-- Local ComfyUI -->
      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">🖥️</span> Local ComfyUI</div>
        <div class="panel-subtitle">
          Use a ComfyUI instance on this machine or your LAN for free local image/video generation. When connected,
          <strong>Local ComfyUI</strong> appears as a provider in Sprite Prep and Generate Video. Pick a template from
          Comfy’s catalog (or paste a custom API-format workflow).
        </div>

        <div class="status-msg mt-1" [class]="comfyConnectedClass()">
          {{ settings.comfyStatusText() || (settings.comfyConnected() ? 'Connected' : 'Not connected') }}
        </div>

        <div class="form-row mt-1">
          <label>ComfyUI base URL</label>
          <div class="api-key-row">
            <input
              type="text"
              [(ngModel)]="comfyUrlDraft"
              placeholder="http://127.0.0.1:8188"
              title="ComfyUI server URL"
              style="flex:1; min-width: 12rem"
            />
            <button type="button" class="btn btn-sm btn-secondary" (click)="connectComfy()">Connect</button>
            <button type="button" class="btn btn-sm btn-accent" (click)="testComfy()">Test</button>
            @if (settings.comfyConnected()) {
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                title="Open the ComfyUI graph editor in a new tab (same host as the API)"
                (click)="openComfyUi()"
              >
                🔗 Open UI
              </button>
              <button type="button" class="btn btn-sm btn-danger" (click)="disconnectComfy()">Disconnect</button>
            }
          </div>
          @if (settings.comfyConnected()) {
            <div class="text-dim mt-1" style="font-size: 0.72rem">
              Opens the full ComfyUI interface at
              <span class="text-mono">{{ settings.comfyBaseUrl() }}</span>
              — useful for editing custom workflows, then re-export API JSON or pick From history here.
            </div>
          }
        </div>

        <div class="flex items-center gap-sm mt-1" style="flex-wrap: wrap">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            [disabled]="settings.comfyScanning()"
            (click)="scanComfy(false)"
          >
            {{ settings.comfyScanning() ? 'Scanning…' : 'Scan localhost' }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            [disabled]="settings.comfyScanning()"
            (click)="scanComfy(true)"
          >
            Scan LAN
          </button>
          <label class="toggle-switch" title="Automatically connect when a ComfyUI instance is found">
            <input
              type="checkbox"
              [checked]="settings.comfyAuto()"
              (change)="onComfyAutoToggle($event)"
            />
            <span class="slider"></span>
          </label>
          <label style="margin-bottom:0; font-size: 0.85rem">Auto-connect when found</label>
        </div>

        @if (settings.comfyCandidates().length) {
          <div class="form-row mt-1">
            <label>Found instances</label>
            <div class="comfy-candidates">
              @for (c of settings.comfyCandidates(); track c.baseUrl) {
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  [class.active]="settings.comfyBaseUrl() === c.baseUrl"
                  (click)="pickComfyCandidate(c.baseUrl)"
                >
                  {{ c.baseUrl }}{{ c.local ? ' (local)' : '' }}
                </button>
              }
            </div>
          </div>
        }

        @if (settings.comfyConnected()) {
          <hr class="gold-divider" />

          <div class="form-row">
            <label class="flex items-center gap-sm" style="margin-bottom: 0.5rem">
              <input
                type="checkbox"
                [checked]="settings.comfyIncludeApiTemplates()"
                (change)="onComfyIncludeApi($event)"
              />
              Show cloud API templates (need external keys inside ComfyUI)
            </label>
          </div>

          <div class="flex items-center gap-sm mt-1" style="flex-wrap: wrap">
            <button type="button" class="btn btn-sm btn-secondary" (click)="refreshComfyLists()">
              ↻ Refresh templates, history &amp; models
            </button>
          </div>

          <div class="form-row mt-1">
            <label>Image workflow</label>
            <select
              class="form-select"
              [ngModel]="settings.comfyImageTemplateId()"
              (ngModelChange)="onImageTemplateChange($event)"
              title="ComfyUI image workflow source"
            >
              <option value="custom">Custom (API JSON)…</option>
              @if (settings.comfyImageHistory().length) {
                <optgroup label="From history">
                  @for (h of settings.comfyImageHistory(); track h.id) {
                    <option [value]="h.id">{{ h.title }}</option>
                  }
                </optgroup>
              }
              @if (settings.comfyImageTemplates().length) {
                <optgroup label="Templates">
                  @for (t of settings.comfyImageTemplates(); track t.id) {
                    <option [value]="t.id">{{ settings.comfyTemplateOptionLabel(t) }}</option>
                  }
                </optgroup>
              }
            </select>
            @if (selectedImageWorkflowDesc()) {
              <div class="text-dim mt-1" style="font-size: 0.75rem">{{ selectedImageWorkflowDesc() }}</div>
            }
          </div>

          @if (settings.comfyImageTemplateId() === 'custom') {
            <div class="form-row mt-1">
              <label>Custom image workflow (API or UI format JSON)</label>
              <app-upload-zone
                accept=".json,application/json"
                icon="📄"
                text="Drop workflow JSON or click to browse"
                hint="ComfyUI Save / Save (API Format)"
                [compact]="true"
                [forceContent]="!!comfyImageWorkflowFile()"
                (filesSelected)="onCustomWorkflowFile('image', $event)"
                (cleared)="clearCustomWorkflowFile('image')"
              />
              @if (comfyImageWorkflowFile()) {
                <div class="text-dim mt-1" style="font-size: 0.72rem">
                  Loaded: <strong>{{ comfyImageWorkflowFile() }}</strong>
                </div>
              }
              <textarea
                rows="6"
                class="comfy-workflow-ta mt-1"
                [class.drag-over]="comfyImageTaDrag()"
                [ngModel]="settings.comfyImageCustomWorkflow()"
                (ngModelChange)="onCustomWorkflowText('image', $event)"
                (dragenter)="onWorkflowTaDrag($event, 'image', true)"
                (dragover)="onWorkflowTaDrag($event, 'image', true)"
                (dragleave)="onWorkflowTaDrag($event, 'image', false)"
                (drop)="onWorkflowTaDrop($event, 'image')"
                placeholder='Paste JSON, or drop a .json file here. Optional node titles: __PROMPT__, __IMAGE_0__'
              ></textarea>
            </div>
          }

          <div class="form-row mt-1">
            <label>Video workflow</label>
            <select
              class="form-select"
              [ngModel]="settings.comfyVideoTemplateId()"
              (ngModelChange)="onVideoTemplateChange($event)"
              title="ComfyUI video workflow source"
            >
              <option value="custom">Custom (API JSON)…</option>
              @if (settings.comfyVideoHistory().length) {
                <optgroup label="From history">
                  @for (h of settings.comfyVideoHistory(); track h.id) {
                    <option [value]="h.id">{{ h.title }}</option>
                  }
                </optgroup>
              }
              @if (settings.comfyVideoTemplates().length) {
                <optgroup label="Templates">
                  @for (t of settings.comfyVideoTemplates(); track t.id) {
                    <option [value]="t.id">{{ settings.comfyTemplateOptionLabel(t) }}</option>
                  }
                </optgroup>
              }
            </select>
            @if (selectedVideoWorkflowDesc()) {
              <div class="text-dim mt-1" style="font-size: 0.75rem">{{ selectedVideoWorkflowDesc() }}</div>
            }
          </div>

          @if (settings.comfyVideoTemplateId() === 'custom') {
            <div class="form-row mt-1">
              <label>Custom video workflow (API or UI format JSON)</label>
              <app-upload-zone
                accept=".json,application/json"
                icon="📄"
                text="Drop workflow JSON or click to browse"
                hint="ComfyUI Save / Save (API Format)"
                [compact]="true"
                [forceContent]="!!comfyVideoWorkflowFile()"
                (filesSelected)="onCustomWorkflowFile('video', $event)"
                (cleared)="clearCustomWorkflowFile('video')"
              />
              @if (comfyVideoWorkflowFile()) {
                <div class="text-dim mt-1" style="font-size: 0.72rem">
                  Loaded: <strong>{{ comfyVideoWorkflowFile() }}</strong>
                </div>
              }
              <textarea
                rows="6"
                class="comfy-workflow-ta mt-1"
                [class.drag-over]="comfyVideoTaDrag()"
                [ngModel]="settings.comfyVideoCustomWorkflow()"
                (ngModelChange)="onCustomWorkflowText('video', $event)"
                (dragenter)="onWorkflowTaDrag($event, 'video', true)"
                (dragover)="onWorkflowTaDrag($event, 'video', true)"
                (dragleave)="onWorkflowTaDrag($event, 'video', false)"
                (drop)="onWorkflowTaDrop($event, 'video')"
                placeholder='Paste JSON, or drop a .json file here'
              ></textarea>
            </div>
          }

          <hr class="gold-divider" />

          <div class="panel-title" style="font-size: 0.95rem">
            <span class="title-icon">📦</span> Models in workflow
            @if (settings.comfyModelsLoading()) {
              <span class="text-dim" style="font-size: 0.7rem; font-weight: 500; margin-left: 0.35rem"
                >loading…</span
              >
            }
          </div>
          <div class="panel-subtitle">
            Dropdowns list only models ComfyUI accepts for that node type (from object_info — same filters as the Comfy
            UI). <strong>Workflow Default</strong> leaves the graph’s choice untouched (recommended). Only pick a file
            when you intentionally override. Disable a LoRA to run at strength 0.
          </div>

          <!-- Image models -->
          <div class="form-row mt-1">
            <label class="text-gold" style="font-weight: 600">Image workflow models</label>
            @if (
              !settings.comfyImageModelSlots().checkpoints.length &&
              !settings.comfyImageModelSlots().unets.length &&
              !settings.comfyImageModelSlots().loras.length
            ) {
              <div class="text-dim" style="font-size: 0.75rem">
                No checkpoint/LoRA loaders detected in the image workflow (or no workflow selected).
              </div>
            }

            @for (c of settings.comfyImageModelSlots().checkpoints; track c.nodeId + '::' + c.field) {
              <div class="comfy-model-row">
                <label
                  >{{ c.title }}
                  <span class="text-dim">({{ c.classType }} · {{ c.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="c.selected"
                  (ngModelChange)="settings.updateComfyCheckpoint('image', c.nodeId, $event, c.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(c.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(c); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (u of settings.comfyImageModelSlots().unets; track u.nodeId + '::' + u.field) {
              <div class="comfy-model-row">
                <label
                  >{{ u.title }}
                  <span class="text-dim">({{ u.classType }} · {{ u.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="u.selected"
                  (ngModelChange)="settings.updateComfyUnet('image', u.nodeId, $event, u.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(u.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(u); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (cl of settings.comfyImageModelSlots().clips; track cl.nodeId + '::' + cl.field) {
              <div class="comfy-model-row">
                <label
                  >{{ cl.title }}
                  <span class="text-dim">(text encoder · {{ cl.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="cl.selected"
                  (ngModelChange)="settings.updateComfyClip('image', cl.nodeId, $event, cl.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(cl.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(cl); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (l of settings.comfyImageModelSlots().loras; track l.nodeId) {
              <div class="comfy-lora-card">
                <div class="flex items-center gap-sm" style="flex-wrap: wrap">
                  <label class="toggle-switch" [title]="'Enable ' + l.title">
                    <input
                      type="checkbox"
                      [checked]="l.enabled"
                      (change)="onLoraEnabled('image', l.nodeId, $event)"
                    />
                    <span class="slider"></span>
                  </label>
                  <strong style="font-size: 0.85rem">{{ l.title }}</strong>
                  <span class="text-dim" style="font-size: 0.72rem">{{ l.classType }}</span>
                </div>
                <select
                  class="form-select mt-1"
                  [disabled]="!l.enabled"
                  [ngModel]="l.selected"
                  (ngModelChange)="settings.updateComfyLora('image', l.nodeId, { selected: $event })"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(l.lora_name) }}
                  </option>
                  @for (m of settings.modelSlotOptions(l); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
                <div class="comfy-lora-strengths mt-1" [class.dimmed]="!l.enabled">
                  <label>
                    Model
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.05"
                      [ngModel]="l.strength_model"
                      (ngModelChange)="
                        settings.updateComfyLora('image', l.nodeId, { strength_model: +$event })
                      "
                      [disabled]="!l.enabled"
                    />
                  </label>
                  <label>
                    CLIP
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.05"
                      [ngModel]="l.strength_clip"
                      (ngModelChange)="
                        settings.updateComfyLora('image', l.nodeId, { strength_clip: +$event })
                      "
                      [disabled]="!l.enabled"
                    />
                  </label>
                </div>
              </div>
            }
          </div>

          <!-- Video models -->
          <div class="form-row mt-1">
            <label class="text-gold" style="font-weight: 600">Video workflow models</label>
            @if (
              !settings.comfyVideoModelSlots().checkpoints.length &&
              !settings.comfyVideoModelSlots().unets.length &&
              !settings.comfyVideoModelSlots().loras.length
            ) {
              <div class="text-dim" style="font-size: 0.75rem">
                No checkpoint/LoRA loaders detected in the video workflow (or no workflow selected).
              </div>
            }

            @for (c of settings.comfyVideoModelSlots().checkpoints; track c.nodeId + '::' + c.field) {
              <div class="comfy-model-row">
                <label
                  >{{ c.title }}
                  <span class="text-dim">({{ c.classType }} · {{ c.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="c.selected"
                  (ngModelChange)="settings.updateComfyCheckpoint('video', c.nodeId, $event, c.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(c.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(c); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (u of settings.comfyVideoModelSlots().unets; track u.nodeId + '::' + u.field) {
              <div class="comfy-model-row">
                <label
                  >{{ u.title }}
                  <span class="text-dim">({{ u.classType }} · {{ u.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="u.selected"
                  (ngModelChange)="settings.updateComfyUnet('video', u.nodeId, $event, u.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(u.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(u); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (cl of settings.comfyVideoModelSlots().clips; track cl.nodeId + '::' + cl.field) {
              <div class="comfy-model-row">
                <label
                  >{{ cl.title }}
                  <span class="text-dim">(text encoder · {{ cl.field }})</span></label
                >
                <select
                  class="form-select"
                  [ngModel]="cl.selected"
                  (ngModelChange)="settings.updateComfyClip('video', cl.nodeId, $event, cl.field)"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(cl.current) }}
                  </option>
                  @for (m of settings.modelSlotOptions(cl); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
              </div>
            }

            @for (l of settings.comfyVideoModelSlots().loras; track l.nodeId) {
              <div class="comfy-lora-card">
                <div class="flex items-center gap-sm" style="flex-wrap: wrap">
                  <label class="toggle-switch" [title]="'Enable ' + l.title">
                    <input
                      type="checkbox"
                      [checked]="l.enabled"
                      (change)="onLoraEnabled('video', l.nodeId, $event)"
                    />
                    <span class="slider"></span>
                  </label>
                  <strong style="font-size: 0.85rem">{{ l.title }}</strong>
                  <span class="text-dim" style="font-size: 0.72rem">{{ l.classType }}</span>
                </div>
                <select
                  class="form-select mt-1"
                  [disabled]="!l.enabled"
                  [ngModel]="l.selected"
                  (ngModelChange)="settings.updateComfyLora('video', l.nodeId, { selected: $event })"
                >
                  <option [value]="settings.workflowDefaultValue">
                    {{ settings.workflowDefaultOptionLabel(l.lora_name) }}
                  </option>
                  @for (m of settings.modelSlotOptions(l); track m) {
                    <option [value]="m">{{ m }}</option>
                  }
                </select>
                <div class="comfy-lora-strengths mt-1" [class.dimmed]="!l.enabled">
                  <label>
                    Model
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.05"
                      [ngModel]="l.strength_model"
                      (ngModelChange)="
                        settings.updateComfyLora('video', l.nodeId, { strength_model: +$event })
                      "
                      [disabled]="!l.enabled"
                    />
                  </label>
                  <label>
                    CLIP
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.05"
                      [ngModel]="l.strength_clip"
                      (ngModelChange)="
                        settings.updateComfyLora('video', l.nodeId, { strength_clip: +$event })
                      "
                      [disabled]="!l.enabled"
                    />
                  </label>
                </div>
              </div>
            }
          </div>

          <div class="text-dim mt-1" style="font-size: 0.72rem">
            <strong>Custom</strong> is first for power users. <strong>From history</strong> reuses workflows from past
            ComfyUI runs (prompt + graph) so you can re-run with this app’s prompt/images.
            <strong>Templates</strong> come from the instance catalog — required models must be installed there.
            Custom JSON: Dev mode → Save (API Format). Optional node titles
            <code>__PROMPT__</code> / <code>__IMAGE_0__</code>.
          </div>
        }
      </div>
      </div><!-- /.settings-col-right -->
    </div>
  `,
  styles: [
    `
      .accel-refresh-btn {
        margin-left: auto;
        font-size: 0.72rem;
      }
      .panel-title {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .accel-badge {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        text-align: left;
        margin-top: 0.75rem;
        padding: 0.85rem 0.95rem;
        border-radius: 10px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
        background: rgba(0, 0, 0, 0.22);
      }
      .accel-badge.accel-webgpu {
        border-color: rgba(94, 210, 168, 0.45);
        box-shadow: 0 0 0 1px rgba(94, 210, 168, 0.12);
      }
      .accel-badge.accel-cpu {
        border-color: rgba(255, 255, 255, 0.1);
      }
      .accel-badge.accel-checking {
        opacity: 0.9;
      }
      .accel-icon {
        font-size: 1.45rem;
        line-height: 1.3;
        flex-shrink: 0;
      }
      .accel-text {
        flex: 1;
        min-width: 0;
      }
      .accel-title-row {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
        margin-bottom: 0.25rem;
      }
      .accel-label {
        font-size: 0.72rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-dim, #9aa3b5);
      }
      .accel-pill {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.12rem 0.5rem;
        border-radius: 999px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        color: var(--text, #e0e0e0);
      }
      .accel-webgpu .accel-pill {
        color: #7eecc0;
        border-color: rgba(94, 210, 168, 0.5);
        background: rgba(94, 210, 168, 0.1);
      }
      .accel-cpu .accel-pill {
        color: #c5cde0;
        background: rgba(255, 255, 255, 0.04);
      }
      .accel-stage {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 0.65rem;
        color: var(--text-dim, #9aa3b5);
      }
      .accel-summary {
        font-size: 0.82rem;
        color: var(--text, #e0e0e0);
        line-height: 1.35;
      }
      .accel-adapter {
        color: var(--accent-gold, #dbb858);
      }
      .accel-detail {
        margin-top: 0.4rem;
        font-size: 0.72rem;
        line-height: 1.45;
        color: var(--text-dim, #9aa3b5);
      }
      .accel-fail-reason {
        margin-top: 0.45rem;
        font-size: 0.72rem;
        line-height: 1.4;
        color: #f0b4b4;
        padding: 0.4rem 0.5rem;
        border-radius: 6px;
        background: rgba(220, 80, 80, 0.12);
        border: 1px solid rgba(220, 80, 80, 0.25);
      }
      .accel-diag {
        list-style: none;
        margin: 0.55rem 0 0;
        padding: 0;
        display: grid;
        gap: 0.25rem;
      }
      .accel-diag li {
        display: flex;
        gap: 0.5rem;
        font-size: 0.7rem;
        flex-wrap: wrap;
      }
      .diag-k {
        min-width: 5.5rem;
        color: var(--text-dim, #9aa3b5);
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .diag-v {
        color: var(--text, #e0e0e0);
        word-break: break-word;
      }
      .diag-ok {
        color: #7eecc0;
      }
      .diag-bad {
        color: #f0b4b4;
      }
      .xai-backend-inactive {
        opacity: 0.72;
      }
      .grok-device-code-box {
        padding: 0.75rem;
        border: 1px solid var(--accent-gold, #dbb858);
      }
      .comfy-candidates {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .comfy-candidates .btn.active {
        border-color: var(--accent-gold, #dbb858);
        color: var(--accent-gold, #dbb858);
      }
      .comfy-workflow-ta {
        width: 100%;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        background: var(--bg-input, #0f1a30);
        color: var(--text, #e0e0e0);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 8px;
        padding: 0.5rem;
        resize: vertical;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .comfy-workflow-ta.drag-over {
        border-color: var(--accent-gold, #dbb858);
        box-shadow: 0 0 0 2px rgba(219, 184, 88, 0.25);
      }
      .form-select {
        width: 100%;
        max-width: 36rem;
        background: var(--bg-input, #0f1a30);
        color: var(--text, #e0e0e0);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        padding: 0.45rem 0.6rem;
      }
      .comfy-model-row {
        margin-top: 0.5rem;
      }
      .comfy-model-row label {
        display: block;
        font-size: 0.8rem;
        margin-bottom: 0.25rem;
      }
      .comfy-lora-card {
        margin-top: 0.65rem;
        padding: 0.65rem;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 8px;
        background: var(--bg-panel-alt, #1b2a4a);
      }
      .comfy-lora-strengths {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }
      .comfy-lora-strengths.dimmed {
        opacity: 0.55;
      }
      .comfy-lora-strengths label {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.75rem;
        margin: 0;
      }
      .comfy-lora-strengths input[type='number'] {
        width: 4.5rem;
        background: var(--bg-input, #0f1a30);
        color: var(--text, #e0e0e0);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 6px;
        padding: 0.25rem 0.4rem;
      }
    `,
  ],
})
export class SettingsComponent implements OnInit {
  readonly settings = inject(SettingsService);
  readonly toast = inject(ToastService);
  readonly sound = inject(NotificationSoundService);
  readonly oauth = inject(XaiOAuthService);

  openaiDraft = this.settings.openaiKey();
  googleDraft = this.settings.googleKey();
  xaiDraft = this.settings.xaiKey();
  comfyUrlDraft = this.settings.comfyBaseUrl() || 'http://127.0.0.1:8188';
  /** Filename last loaded into custom image/video workflow fields. */
  readonly comfyImageWorkflowFile = signal('');
  readonly comfyVideoWorkflowFile = signal('');
  readonly comfyImageTaDrag = signal(false);
  readonly comfyVideoTaDrag = signal(false);
  readonly showOpenAI = signal(false);
  readonly showGoogle = signal(false);
  readonly showXai = signal(false);
  readonly openaiStatus = signal<{ type: string; text: string } | null>(null);
  readonly googleStatus = signal<{ type: string; text: string } | null>(null);
  readonly xaiStatus = signal<{ type: string; text: string } | null>(null);

  readonly oauthLoginPhase = signal<'idle' | 'progress'>('idle');
  readonly oauthProgressMsg = signal('Waiting for browser approval…');
  readonly oauthDeviceCode = signal('');
  readonly oauthVerifyUrl = signal('');
  readonly oauthStatusMsg = signal<{ type: string; text: string } | null>(null);

  /** Export chroma acceleration (WebGPU vs CPU) for the About card. */
  readonly accel = signal<ExportAccelProbe | null>(null);
  readonly accelChecking = signal(true);
  readonly accelAdapterLine = computed(() => {
    const a = this.accel();
    if (!a) return '';
    return [a.vendor, a.adapterName].filter(Boolean).join(' · ');
  });

  private loginAbort: AbortController | null = null;

  readonly oauthStatus = computed(() => this.oauth.getStatus());

  readonly oauthExpiresText = computed(() => {
    const s = this.oauthStatus();
    if (!s.loggedIn || !s.expiresAt) return '';
    const d = new Date(s.expiresAt);
    return `Token expires: ${d.toLocaleString()} · Refresh: ${s.hasRefresh ? 'available' : 'none'}`;
  });

  constructor() {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }

  ngOnInit(): void {
    void this.loadAccel(false);
  }

  async refreshAccel(): Promise<void> {
    await this.loadAccel(true);
    const a = this.accel();
    if (a) {
      this.toast.show(
        a.backend === 'webgpu'
          ? `Export chroma: WebGPU${this.accelAdapterLine() ? ` (${this.accelAdapterLine()})` : ''}`
          : `Export chroma: CPU — ${a.reason || 'WebGPU unavailable'}`,
        a.backend === 'webgpu' ? 'success' : 'info'
      );
    }
  }

  private async loadAccel(force: boolean): Promise<void> {
    this.accelChecking.set(true);
    try {
      const result = await probeExportAcceleration({ force });
      this.accel.set(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.accel.set({
        backend: 'cpu',
        label: 'CPU',
        summary: 'CPU workers',
        detail: 'Could not probe acceleration; export will use CPU workers.',
        reason: msg,
      });
    } finally {
      this.accelChecking.set(false);
    }
  }

  setXaiBackend(backend: XaiBackend): void {
    this.settings.setXaiBackend(backend);
    this.toast.show(
      `Grok backend: ${backend === 'oauth' ? 'SuperGrok OAuth' : 'API Key'}`,
      'info'
    );
  }

  /** Whether GPU export mode can be selected (WebGPU probe succeeded). */
  readonly webgpuExportAvailable = computed(() => {
    if (this.accelChecking()) return false;
    const a = this.accel();
    return !!a && a.backend === 'webgpu' && a.stage === 'ready';
  });

  setPreviewAccel(mode: 'auto' | 'cpu'): void {
    this.settings.setPreviewAccelMode(mode);
    this.toast.show(
      mode === 'cpu' ? 'Preview mode: CPU only' : 'Preview mode: Auto (WebGPU when available)',
      mode === 'cpu' ? 'warning' : 'info'
    );
    void this.loadAccel(true);
  }

  setExportPipeline(mode: 'cpu' | 'gpu'): void {
    if (mode === 'gpu' && !this.webgpuExportAvailable()) {
      this.toast.show('WebGPU is not available — use CPU export', 'warning');
      return;
    }
    this.settings.setExportPipelineMode(mode);
    const labels: Record<'cpu' | 'gpu', string> = {
      cpu: 'CPU (PNG + workers + ffmpeg)',
      gpu: 'GPU (WebGPU key + raw + ffmpeg)',
    };
    this.toast.show(`Export mode: ${labels[mode]}`, 'info');
  }

  /** @deprecated */
  setExportAccel(mode: 'auto' | 'cpu'): void {
    this.setPreviewAccel(mode);
  }

  saveOpenAI(): void {
    this.settings.saveOpenAIKey(this.openaiDraft);
    this.toast.show(
      this.openaiDraft.trim() ? 'OpenAI API key saved' : 'OpenAI API key removed',
      this.openaiDraft.trim() ? 'success' : 'warning'
    );
  }

  saveGoogle(): void {
    this.settings.saveGoogleKey(this.googleDraft);
    this.toast.show(
      this.googleDraft.trim() ? 'Google API key saved' : 'Google API key removed',
      this.googleDraft.trim() ? 'success' : 'warning'
    );
  }

  saveXai(): void {
    this.settings.saveXaiKey(this.xaiDraft);
    this.toast.show(
      this.xaiDraft.trim() ? 'xAI Grok API key saved' : 'xAI Grok API key removed',
      this.xaiDraft.trim() ? 'success' : 'warning'
    );
  }

  async testOpenAI(): Promise<void> {
    const key = this.openaiDraft.trim();
    if (!key) {
      this.openaiStatus.set({ type: 'error', text: 'Enter an API key first' });
      return;
    }
    this.openaiStatus.set({ type: 'info', text: 'Testing connection...' });
    try {
      await this.settings.testOpenAI(key);
      this.settings.saveOpenAIKey(key);
      this.openaiStatus.set({ type: 'success', text: '✅ Connection successful!' });
    } catch (err) {
      this.openaiStatus.set({
        type: 'error',
        text: `❌ ${(err as Error).message || 'Failed'}. Is the server running?`,
      });
    }
  }

  async testGoogle(): Promise<void> {
    const key = this.googleDraft.trim();
    if (!key) {
      this.googleStatus.set({ type: 'error', text: 'Enter an API key first' });
      return;
    }
    this.googleStatus.set({ type: 'info', text: 'Testing connection...' });
    try {
      await this.settings.testGoogle(key);
      this.settings.saveGoogleKey(key);
      this.googleStatus.set({ type: 'success', text: '✅ Connection successful!' });
    } catch (err) {
      this.googleStatus.set({ type: 'error', text: `❌ ${(err as Error).message}` });
    }
  }

  async testXaiKey(): Promise<void> {
    const key = this.xaiDraft.trim();
    if (!key) {
      this.xaiStatus.set({ type: 'error', text: 'Enter an API key first' });
      return;
    }
    this.xaiStatus.set({ type: 'info', text: 'Testing connection...' });
    try {
      await this.settings.testXai(key);
      const cleaned = key
        .trim()
        .replace(/^Bearer\s+/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();
      this.xaiDraft = cleaned;
      this.settings.saveXaiKey(cleaned);
      this.xaiStatus.set({ type: 'success', text: '✅ Connection successful!' });
    } catch (err) {
      const msg = (err as Error).message || 'Failed';
      const needsServerHint =
        /proxy|ECONNREFUSED|Failed to fetch|NetworkError|status 0|HTTP 502/i.test(msg);
      this.xaiStatus.set({
        type: 'error',
        text: needsServerHint ? `❌ ${msg}. Is the server running?` : `❌ ${msg}`,
      });
    }
  }

  async startOAuthLogin(): Promise<void> {
    this.oauthStatusMsg.set(null);
    this.oauthLoginPhase.set('progress');
    this.oauthProgressMsg.set('Requesting device code from xAI…');
    this.oauthDeviceCode.set('');
    this.oauthVerifyUrl.set('');
    this.loginAbort = new AbortController();

    try {
      await this.oauth.login((info: XaiOAuthLoginProgress) => {
        if (typeof info === 'string') {
          this.oauthProgressMsg.set(info);
          return;
        }
        if (info.type === 'device_code') {
          this.oauthDeviceCode.set(info.user_code || '----');
          this.oauthVerifyUrl.set(info.url || '');
          this.oauthProgressMsg.set('Waiting for you to approve in the browser…');
          this.toast.show('Device code ready — approve in the browser', 'info');
        }
      }, this.loginAbort.signal);

      this.oauthLoginPhase.set('idle');
      this.oauthDeviceCode.set('');
      this.oauthVerifyUrl.set('');
      this.toast.show('SuperGrok login successful! ✨', 'success');
      this.sound.play();
      // Prefer OAuth once logged in so the user doesn't forget to flip the toggle
      if (this.settings.xaiBackend() !== 'oauth') {
        this.settings.setXaiBackend('oauth');
        this.toast.show('Active Grok backend set to SuperGrok OAuth', 'info');
      }
    } catch (err) {
      const msg = (err as Error).message || 'Login failed';
      this.oauthLoginPhase.set('idle');
      this.oauthDeviceCode.set('');
      this.oauthVerifyUrl.set('');
      if (msg !== 'Login cancelled') {
        this.oauthStatusMsg.set({ type: 'error', text: `❌ ${msg}` });
        this.toast.show(msg, 'error');
      } else {
        this.toast.show('Login cancelled', 'warning');
      }
    } finally {
      this.loginAbort = null;
    }
  }

  cancelOAuthLogin(): void {
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.oauthLoginPhase.set('idle');
    this.oauthDeviceCode.set('');
    this.oauthVerifyUrl.set('');
    this.toast.show('Login cancelled', 'warning');
  }

  logoutOAuth(): void {
    this.oauth.logout();
    this.oauthStatusMsg.set(null);
    this.toast.show('SuperGrok session cleared', 'info');
  }

  async testOAuth(): Promise<void> {
    this.oauthStatusMsg.set({ type: 'info', text: 'Testing SuperGrok token…' });
    try {
      const token = await this.oauth.getAccessToken();
      if (!token) throw new Error('No valid token. Please login again.');
      await this.settings.testXai(token);
      this.oauthStatusMsg.set({ type: 'success', text: '✅ SuperGrok token is valid!' });
      this.toast.show('Grok connection OK', 'success');
    } catch (err) {
      const msg = (err as Error).message || 'Failed';
      this.oauthStatusMsg.set({ type: 'error', text: `❌ ${msg}` });
      this.toast.show(msg, 'error');
    }
  }

  async refreshOAuth(): Promise<void> {
    this.oauthStatusMsg.set({ type: 'info', text: 'Refreshing token…' });
    try {
      const token = await this.oauth.forceRefresh();
      if (!token) throw new Error('Refresh failed — please re-login');
      this.oauthStatusMsg.set({ type: 'success', text: '✅ Token refreshed' });
      this.toast.show('Token refreshed', 'success');
    } catch (err) {
      const msg = (err as Error).message || 'Failed';
      this.oauthStatusMsg.set({ type: 'error', text: `❌ ${msg}` });
      this.toast.show(msg, 'error');
    }
  }

  onSoundToggle(e: Event): void {
    this.settings.setSoundEnabled((e.target as HTMLInputElement).checked);
  }

  comfyConnectedClass(): string {
    if (this.settings.comfyScanning()) return 'info';
    if (this.settings.comfyConnected()) return 'success';
    if (this.settings.comfyStatusText() && /fail|error|no |not /i.test(this.settings.comfyStatusText())) {
      return 'error';
    }
    return 'info';
  }

  selectedImageWorkflowDesc(): string {
    const id = this.settings.comfyImageTemplateId();
    if (!id || id === 'custom') {
      return id === 'custom'
        ? 'Paste API-format JSON below. Prompt/images from Sprite Prep are injected when possible.'
        : '';
    }
    if (id.startsWith('history:')) {
      const h = this.settings.comfyImageHistory().find((x) => x.id === id);
      return h?.description || 'Re-run this past ComfyUI graph with a new prompt / references.';
    }
    const t = this.settings.comfyImageTemplates().find((x) => x.id === id);
    if (!t) return '';
    const cloud = t.isApi ? '☁️ Cloud API template (needs external keys inside ComfyUI). ' : '';
    const models = t.models?.length ? ` · models: ${t.models.join(', ')}` : '';
    return `${cloud}${t.description || ''}${models}`.trim();
  }

  selectedVideoWorkflowDesc(): string {
    const id = this.settings.comfyVideoTemplateId();
    if (!id || id === 'custom') {
      return id === 'custom'
        ? 'Paste API-format JSON below. Prompt/start frame from Video Gen are injected when possible.'
        : '';
    }
    if (id.startsWith('history:')) {
      const h = this.settings.comfyVideoHistory().find((x) => x.id === id);
      return h?.description || 'Re-run this past ComfyUI graph with a new prompt / references.';
    }
    const t = this.settings.comfyVideoTemplates().find((x) => x.id === id);
    if (!t) return '';
    const cloud = t.isApi ? '☁️ Cloud API template (needs external keys inside ComfyUI). ' : '';
    const models = t.models?.length ? ` · models: ${t.models.join(', ')}` : '';
    return `${cloud}${t.description || ''}${models}`.trim();
  }

  async refreshComfyLists(): Promise<void> {
    try {
      await this.settings.refreshComfyTemplates();
      this.toast.show('ComfyUI templates, history & models refreshed', 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Refresh failed', 'error');
    }
  }

  onLoraEnabled(kind: 'image' | 'video', nodeId: string, e: Event): void {
    const enabled = (e.target as HTMLInputElement).checked;
    this.settings.updateComfyLora(kind, nodeId, { enabled });
  }

  onCustomWorkflowText(kind: 'image' | 'video', text: string): void {
    if (kind === 'image') {
      this.settings.setComfyImageCustomWorkflow(text);
      // Manual edit — clear file label unless empty wipe
      if (!text.trim()) this.comfyImageWorkflowFile.set('');
    } else {
      this.settings.setComfyVideoCustomWorkflow(text);
      if (!text.trim()) this.comfyVideoWorkflowFile.set('');
    }
  }

  async onCustomWorkflowFile(kind: 'image' | 'video', files: FileList): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    await this.loadCustomWorkflowFromFile(kind, file);
  }

  clearCustomWorkflowFile(kind: 'image' | 'video'): void {
    if (kind === 'image') {
      this.comfyImageWorkflowFile.set('');
      this.settings.setComfyImageCustomWorkflow('');
    } else {
      this.comfyVideoWorkflowFile.set('');
      this.settings.setComfyVideoCustomWorkflow('');
    }
    this.toast.show(`Custom ${kind} workflow cleared`, 'info');
  }

  onWorkflowTaDrag(e: DragEvent, kind: 'image' | 'video', over: boolean): void {
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'image') this.comfyImageTaDrag.set(over);
    else this.comfyVideoTaDrag.set(over);
  }

  async onWorkflowTaDrop(e: DragEvent, kind: 'image' | 'video'): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'image') this.comfyImageTaDrag.set(false);
    else this.comfyVideoTaDrag.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await this.loadCustomWorkflowFromFile(kind, file);
  }

  private async loadCustomWorkflowFromFile(kind: 'image' | 'video', file: File): Promise<void> {
    const name = file.name || 'workflow.json';
    const lower = name.toLowerCase();
    if (!lower.endsWith('.json') && file.type && !file.type.includes('json') && !file.type.includes('text')) {
      this.toast.show('Please choose a .json workflow file', 'warning');
      return;
    }

    try {
      const text = await file.text();
      const trimmed = text.trim();
      if (!trimmed) throw new Error('File is empty');

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error('File is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Workflow JSON must be an object');
      }

      // Prefer pretty-printed storage for readability in the textarea
      const pretty = JSON.stringify(parsed, null, 2);
      if (kind === 'image') {
        this.settings.setComfyImageCustomWorkflow(pretty);
        this.comfyImageWorkflowFile.set(name);
      } else {
        this.settings.setComfyVideoCustomWorkflow(pretty);
        this.comfyVideoWorkflowFile.set(name);
      }
      this.toast.show(`Loaded ${name}`, 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Failed to load workflow file', 'error');
    }
  }

  onComfyAutoToggle(e: Event): void {
    this.settings.setComfyAuto((e.target as HTMLInputElement).checked);
  }

  async onComfyIncludeApi(e: Event): Promise<void> {
    const enabled = (e.target as HTMLInputElement).checked;
    try {
      await this.settings.setComfyIncludeApiTemplates(enabled);
      const nImg = this.settings.comfyImageTemplates().length;
      const nVid = this.settings.comfyVideoTemplates().length;
      this.toast.show(
        enabled
          ? `Cloud API templates shown (${nImg} image · ${nVid} video)`
          : `Local templates only (${nImg} image · ${nVid} video)`,
        'info'
      );
    } catch (err) {
      this.toast.show((err as Error).message || 'Failed to refresh templates', 'error');
    }
  }

  onImageTemplateChange(id: string): void {
    this.settings.setComfyImageTemplateId(id);
  }

  onVideoTemplateChange(id: string): void {
    this.settings.setComfyVideoTemplateId(id);
  }

  async scanComfy(lan: boolean): Promise<void> {
    try {
      const found = await this.settings.scanComfy({ lan, autoConnect: true });
      if (this.settings.comfyBaseUrl()) {
        this.comfyUrlDraft = this.settings.comfyBaseUrl();
      }
      this.toast.show(
        found.length
          ? `Found ${found.length} ComfyUI instance(s)`
          : 'No ComfyUI instances found',
        found.length ? 'success' : 'warning'
      );
    } catch (err) {
      this.toast.show((err as Error).message || 'Scan failed', 'error');
    }
  }

  async connectComfy(): Promise<void> {
    try {
      await this.settings.connectComfy(this.comfyUrlDraft);
      this.comfyUrlDraft = this.settings.comfyBaseUrl() || this.comfyUrlDraft;
      this.toast.show('Connected to ComfyUI', 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Connect failed', 'error');
    }
  }

  async testComfy(): Promise<void> {
    try {
      await this.settings.testComfy(this.comfyUrlDraft);
      this.comfyUrlDraft = this.settings.comfyBaseUrl() || this.comfyUrlDraft;
      this.toast.show('ComfyUI connection OK', 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Test failed', 'error');
    }
  }

  async disconnectComfy(): Promise<void> {
    await this.settings.disconnectComfy();
    this.toast.show('ComfyUI disconnected', 'info');
  }

  openComfyUi(): void {
    if (!this.settings.openComfyUi()) {
      this.toast.show('Connect to ComfyUI first', 'warning');
    }
  }

  async pickComfyCandidate(url: string): Promise<void> {
    this.comfyUrlDraft = url;
    await this.connectComfy();
  }
}
