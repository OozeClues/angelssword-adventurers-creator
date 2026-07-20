import { AfterViewInit, Component, OnDestroy, computed, effect, inject } from '@angular/core';
import { PipelineStateService } from '../../core/pipeline-state.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';
import { debounce, hexToRgb } from '../../shared/utils/media';
import { ColorSwatchesComponent } from '../../shared/components/color-swatches.component';
import { initColorSwatches, initModeSelector, initUploadZone } from './dom-bridge';
import { ModelExporter, setExporterHooks } from './model-exporter.engine';

@Component({
  selector: 'app-exporter',
  imports: [ColorSwatchesComponent],
  templateUrl: './exporter.component.html',
  styles: [
    `
      .export-key-color-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.65rem 0.75rem;
      }
      /* Swatches component already lays out picker inline; keep tools beside it */
      .export-key-color-row app-color-swatches {
        display: block;
        min-width: 0;
      }
    `,
  ],
})
export class ExporterComponent implements AfterViewInit, OnDestroy {
  private readonly pipeline = inject(PipelineStateService);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(NotificationSoundService);
  private exporter: ModelExporter | null = null;
  /** Last videoPrepHandoffVersion applied to the engine (avoids reload loops). */
  private lastAppliedPrepVersion = 0;

  /** Bound to app-color-swatches (pipeline key color is source of truth). */
  readonly exportKeyColor = computed(() => this.pipeline.keyColor() || '#00FF00');

  /** Mutable bag the legacy engine observes via defineProperty. */
  private readonly handoffBag: {
    videoPrepData: unknown;
    keyColor: string;
    videoBlob: Blob | null;
    videoUrl: string | null;
  } = {
    videoPrepData: null,
    keyColor: '#00FF00',
    videoBlob: null,
    videoUrl: null,
  };

  constructor() {
    effect(() => {
      const data = this.pipeline.videoPrep();
      const version = this.pipeline.videoPrepHandoffVersion();
      const key = this.pipeline.keyColor();
      this.handoffBag.keyColor = key;
      // Keep exporter chroma UI in sync when Sprite Prep (or anyone) changes key color.
      this.exporter?.applySharedKeyColor?.(key, { persist: false, preview: true });
      // Only push new handoffs once the engine exists; init path is in ngAfterViewInit.
      if (this.exporter && version > this.lastAppliedPrepVersion && data) {
        this.lastAppliedPrepVersion = version;
        // Assignment triggers the engine's defineProperty setter.
        this.handoffBag.videoPrepData = data;
      }
    });
  }

  ngAfterViewInit(): void {
    const pipeline = this.pipeline;
    const handoffBag = this.handoffBag;
    handoffBag.keyColor = pipeline.keyColor();

    const ASAdventurer = {
      get characterName() {
        return pipeline.characterName();
      },
      handoff: handoffBag,
    };

    setExporterHooks({
      showToast: (msg, type) => this.toast.show(msg, (type as 'info') || 'info'),
      hexToRgb,
      debounce: debounce as <T extends (...args: never[]) => void>(fn: T, ms: number) => T,
      initUploadZone,
      initModeSelector,
      initColorSwatches,
      getKeyColor: () => pipeline.keyColor(),
      setKeyColor: (hex: string) => pipeline.setKeyColor(hex),
      getScrubProxy: () => pipeline.videoScrubProxy(),
      setScrubProxy: (bank) => pipeline.setVideoScrubProxy(bank),
      ASAdventurer,
      notificationSound: { play: () => this.sound.play() },
    });

    requestAnimationFrame(() => {
      this.exporter = new ModelExporter();
      // Apply shared key color once the engine DOM is ready.
      this.exporter?.applySharedKeyColor?.(pipeline.keyColor(), {
        persist: false,
        preview: false,
      });
      // Push any existing handoff after engine installed its setter.
      const existing = pipeline.videoPrep();
      const version = pipeline.videoPrepHandoffVersion();
      if (existing && version > 0) {
        this.lastAppliedPrepVersion = version;
        handoffBag.videoPrepData = existing;
      }
    });
  }

  ngOnDestroy(): void {
    this.exporter = null;
  }

  /** Preset / themed picker on Export → chroma key. */
  onExportKeyColor(hex: string): void {
    const n = PipelineStateService.normalizeHex(hex);
    if (!n) return;
    this.pipeline.setKeyColor(n);
    this.exporter?.applySharedKeyColor?.(n, { persist: true, preview: true });
  }

  onEyedropperError(msg: string): void {
    this.toast.show(msg || 'Color picker eyedropper failed', 'warning');
  }
}
