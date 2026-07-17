import { Injectable, inject } from '@angular/core';
import { SettingsService } from './settings.service';

@Injectable({ providedIn: 'root' })
export class NotificationSoundService {
  private readonly settings = inject(SettingsService);
  private audioContext: AudioContext | null = null;
  private buffers: Record<string, AudioBuffer> = {};
  private readonly clips = ['quest_complete_2.mp3', 'quest_complete_10.mp3'];
  private gestureBound = false;

  constructor() {
    this.bindGestureInit();
  }

  private bindGestureInit(): void {
    if (this.gestureBound || typeof document === 'undefined') return;
    this.gestureBound = true;
    const handler = () => {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        void this.preload();
      } else if (this.audioContext.state === 'suspended') {
        void this.audioContext.resume();
      }
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
    };
    document.addEventListener('click', handler);
    document.addEventListener('keydown', handler);
  }

  private async preload(): Promise<void> {
    if (!this.audioContext) return;
    for (const clip of this.clips) {
      try {
        const resp = await fetch(`assets/sounds/${clip}`);
        const buf = await resp.arrayBuffer();
        this.buffers[clip] = await this.audioContext.decodeAudioData(buf);
      } catch (e) {
        console.warn(`[Sound] Failed to preload ${clip}:`, (e as Error).message);
      }
    }
  }

  play(): void {
    if (!this.settings.soundEnabled() || !this.audioContext) return;
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

    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('⚔️ Quest Complete!', {
        body: 'Your generation has finished!',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚔️</text></svg>',
      });
    }
  }
}
