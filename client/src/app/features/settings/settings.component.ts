import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';
import {
  XaiOAuthService,
  type XaiOAuthLoginProgress,
} from '../../core/xai-oauth.service';
import type { XaiBackend } from '../../core/gen-providers';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  template: `
    <div class="settings-section">
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

      <div class="settings-info">
        <span class="info-icon">🔒</span>
        <strong>Privacy:</strong> Your API keys and SuperGrok OAuth tokens are stored in your browser's localStorage
        only. They are never sent to any server except the official OpenAI, Google, and xAI (auth.x.ai / api.x.ai)
        endpoints, via the local proxy server running on your machine.
      </div>
    </div>
  `,
  styles: [
    `
      .xai-backend-inactive {
        opacity: 0.72;
      }
      .grok-device-code-box {
        padding: 0.75rem;
        border: 1px solid var(--accent-gold, #dbb858);
      }
    `,
  ],
})
export class SettingsComponent {
  readonly settings = inject(SettingsService);
  readonly toast = inject(ToastService);
  readonly sound = inject(NotificationSoundService);
  readonly oauth = inject(XaiOAuthService);

  openaiDraft = this.settings.openaiKey();
  googleDraft = this.settings.googleKey();
  xaiDraft = this.settings.xaiKey();
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

  setXaiBackend(backend: XaiBackend): void {
    this.settings.setXaiBackend(backend);
    this.toast.show(
      `Grok backend: ${backend === 'oauth' ? 'SuperGrok OAuth' : 'API Key'}`,
      'info'
    );
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
}
