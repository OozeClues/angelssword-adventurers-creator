import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';

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

      <div class="glass-panel">
        <div class="panel-title"><span class="title-icon">⚡</span> xAI Grok API Key</div>
        <div class="panel-subtitle">
          Required for Grok Imagine image + video generation. Create a key in the xAI console — stored locally only.
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
          <button type="button" class="btn btn-sm btn-accent" (click)="testXai()">Test</button>
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
        <strong>Privacy:</strong> Your API keys are stored in your browser's localStorage only. They are never sent to
        any server except the official OpenAI, Google, and xAI API endpoints, via the local proxy server running on your
        machine.
      </div>
    </div>
  `,
})
export class SettingsComponent {
  readonly settings = inject(SettingsService);
  readonly toast = inject(ToastService);
  readonly sound = inject(NotificationSoundService);

  openaiDraft = this.settings.openaiKey();
  googleDraft = this.settings.googleKey();
  xaiDraft = this.settings.xaiKey();
  readonly showOpenAI = signal(false);
  readonly showGoogle = signal(false);
  readonly showXai = signal(false);
  readonly openaiStatus = signal<{ type: string; text: string } | null>(null);
  readonly googleStatus = signal<{ type: string; text: string } | null>(null);
  readonly xaiStatus = signal<{ type: string; text: string } | null>(null);

  constructor() {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
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

  async testXai(): Promise<void> {
    const key = this.xaiDraft.trim();
    if (!key) {
      this.xaiStatus.set({ type: 'error', text: 'Enter an API key first' });
      return;
    }
    this.xaiStatus.set({ type: 'info', text: 'Testing connection...' });
    try {
      await this.settings.testXai(key);
      // Persist the cleaned key form used by the test path
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
      // Don't blame the local server for upstream auth/permission errors
      const needsServerHint =
        /proxy|ECONNREFUSED|Failed to fetch|NetworkError|status 0|HTTP 502/i.test(msg);
      this.xaiStatus.set({
        type: 'error',
        text: needsServerHint ? `❌ ${msg}. Is the server running?` : `❌ ${msg}`,
      });
    }
  }

  onSoundToggle(e: Event): void {
    this.settings.setSoundEnabled((e.target as HTMLInputElement).checked);
  }
}
