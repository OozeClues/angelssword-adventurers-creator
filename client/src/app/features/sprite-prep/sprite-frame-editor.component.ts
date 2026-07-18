import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PipelineStateService } from '../../core/pipeline-state.service';
import { ColorPickerComponent } from '../../shared/components/color-picker.component';
import { hexToRgb } from '../../shared/utils/color-math';
import { blobToBase64, loadImage } from '../../shared/utils/media';

const CW = 1280;
const CH = 720;

type DragMode = 'move' | 'rotate' | null;

/**
 * Interactive 1280×720 sprite frame editor:
 * - Chroma key fill for unused area
 * - Zoom slider (100% = natural size, center default)
 * - Drag image to reposition; corner handles to rotate
 * - Spill outside the frame is clipped (not exported)
 */
@Component({
  selector: 'app-sprite-frame-editor',
  imports: [FormsModule, ColorPickerComponent],
  template: `
    <div class="sfe">
      <div
        class="sfe-stage canvas-container"
        #stage
        [class.sfe-eyedropper-mode]="eyedropperActive()"
        (pointerenter)="onStageEnter()"
        (pointerleave)="onStageLeave($event)"
        (pointerdown)="onStagePointerDown($event)"
      >
        <canvas #canvas width="1280" height="720" class="sfe-canvas"></canvas>

        @if (hasImage() && showChrome() && !eyedropperActive()) {
          <div
            class="sfe-box"
            [style.left.px]="boxDisp().left"
            [style.top.px]="boxDisp().top"
            [style.width.px]="boxDisp().width"
            [style.height.px]="boxDisp().height"
            [style.transform]="'translate(-50%, -50%) rotate(' + rotationDeg() + 'deg)'"
            (pointerdown)="onBoxPointerDown($event)"
          >
            <div class="sfe-box-body" title="Drag to move"></div>
            <button
              type="button"
              class="sfe-handle sfe-handle-tl"
              title="Drag to rotate"
              (pointerdown)="onRotateHandleDown($event)"
            ></button>
            <button
              type="button"
              class="sfe-handle sfe-handle-tr"
              title="Drag to rotate"
              (pointerdown)="onRotateHandleDown($event)"
            ></button>
            <button
              type="button"
              class="sfe-handle sfe-handle-bl"
              title="Drag to rotate"
              (pointerdown)="onRotateHandleDown($event)"
            ></button>
            <button
              type="button"
              class="sfe-handle sfe-handle-br"
              title="Drag to rotate"
              (pointerdown)="onRotateHandleDown($event)"
            ></button>
          </div>
        }

        @if (eyedropperActive()) {
          <div class="sfe-eyedropper-banner">
            Click the frame to sample a key color · Esc to cancel
          </div>
        }
      </div>

      <div class="sfe-controls">
        <div class="form-row" style="margin-bottom: 0.5rem">
          <label>Key color <span class="text-dim">(chroma fill)</span></label>
          <div class="sfe-key-row">
            <app-color-picker
              [color]="keyColorDisplay()"
              (colorChange)="emitKeyColor($event)"
              triggerTitle="Open themed color picker"
            />
            <span class="text-mono text-dim sfe-key-rgb">
              rgb({{ keyRgb().r }}, {{ keyRgb().g }}, {{ keyRgb().b }})
            </span>
            <button
              type="button"
              class="eyedropper-btn"
              [class.active]="eyedropperActive()"
              [disabled]="!hasImage()"
              title="Sample key color from the preview frame"
              (click)="toggleEyedropper()"
            >
              💧
            </button>
          </div>
          <div class="text-dim" style="font-size: 0.7rem; margin-top: 0.25rem">
            Sample from the frame, or open the picker for HSV / RGB / hex. Colors persist across Sprite Prep → Video →
            Export.
          </div>
        </div>

        <div class="form-row" style="margin-bottom: 0.5rem">
          <label for="sfe-zoom">Zoom</label>
          <div class="range-row">
            <input
              id="sfe-zoom"
              type="range"
              min="10"
              max="300"
              step="1"
              [value]="zoomPct()"
              (input)="onZoomInput($event)"
              title="Zoom: 100% = original size"
            />
            <span class="range-value">{{ zoomPct() }}%</span>
          </div>
          <div class="text-dim" style="font-size: 0.7rem; margin-top: 0.25rem">
            Center = 100% (no change). Zoom out fills empty frame with key color; zoom in enlarges the sprite.
          </div>
        </div>
        <div class="sfe-toolbar">
          <button type="button" class="btn btn-sm btn-secondary" [disabled]="!hasImage()" (click)="resetPlacement()">
            ↺ Reset position
          </button>
          <span class="text-mono text-dim" style="font-size: 0.7rem">
            1280×720 · drag to move · corners rotate · spill clipped
          </span>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .sfe {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .sfe-stage {
        position: relative;
        touch-action: none;
        user-select: none;
        cursor: default;
      }
      .sfe-stage.sfe-eyedropper-mode {
        cursor: crosshair;
      }
      .sfe-canvas {
        display: block;
        width: 100%;
        height: auto;
        pointer-events: none;
      }
      .sfe-eyedropper-banner {
        position: absolute;
        left: 50%;
        bottom: 10px;
        transform: translateX(-50%);
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(15, 26, 48, 0.92);
        border: 1px solid var(--accent-gold, #dbb858);
        color: var(--text-bright, #fff8ee);
        font-size: 0.75rem;
        pointer-events: none;
        white-space: nowrap;
        z-index: 3;
      }
      .sfe-key-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.65rem;
      }
      .sfe-key-rgb {
        font-size: 0.7rem;
      }
      .sfe-box {
        position: absolute;
        box-sizing: border-box;
        border: 1.5px solid var(--accent-gold, #dbb858);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 12px var(--accent-gold-glow, rgba(219, 184, 88, 0.35));
        pointer-events: auto;
        cursor: grab;
      }
      .sfe-box:active {
        cursor: grabbing;
      }
      .sfe-box-body {
        position: absolute;
        inset: 0;
      }
      .sfe-handle {
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--accent-gold, #dbb858);
        border: 2px solid #1a1a2e;
        padding: 0;
        cursor: grab;
        z-index: 2;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
      }
      .sfe-handle:active {
        cursor: grabbing;
      }
      .sfe-handle-tl {
        left: 0;
        top: 0;
        transform: translate(-50%, -50%);
      }
      .sfe-handle-tr {
        right: 0;
        top: 0;
        transform: translate(50%, -50%);
      }
      .sfe-handle-bl {
        left: 0;
        bottom: 0;
        transform: translate(-50%, 50%);
      }
      .sfe-handle-br {
        right: 0;
        bottom: 0;
        transform: translate(50%, 50%);
      }
      .sfe-controls {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .sfe-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
      }
    `,
  ],
})
export class SpriteFrameEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas') canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('stage') stageRef?: ElementRef<HTMLElement>;

  /** Data URL / blob URL of the source sprite. */
  @Input() imageSrc: string | null = null;
  /** Solid chroma fill for unused frame area. */
  @Input() keyColor = '#00FF00';
  /** Emits when the user picks a new key color (picker, hex, or canvas eyedropper). */
  @Output() keyColorChange = new EventEmitter<string>();

  readonly hasImage = signal(false);
  readonly zoomPct = signal(100);
  readonly rotationDeg = signal(0);
  readonly showChrome = signal(false);
  readonly boxDisp = signal({ left: 0, top: 0, width: 0, height: 0 });
  readonly eyedropperActive = signal(false);

  private img: HTMLImageElement | null = null;
  private imgSrcLoaded: string | null = null;
  /** Image center in canvas coords. */
  private cx = CW / 2;
  private cy = CH / 2;
  /** Scale relative to natural pixels (1 = 100%). */
  private scale = 1;
  /** Rotation in radians. */
  private rot = 0;

  private dragMode: DragMode = null;
  private dragPointerId: number | null = null;
  private dragStartCanvas = { x: 0, y: 0 };
  private dragStartCx = 0;
  private dragStartCy = 0;
  private dragStartRot = 0;
  private dragStartAngle = 0;
  private hovering = false;
  private resizeObs: ResizeObserver | null = null;
  private loadToken = 0;

  ngAfterViewInit(): void {
    const stage = this.stageRef?.nativeElement;
    if (stage && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.updateOverlay());
      this.resizeObs.observe(stage);
    }
    void this.reloadImage();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['imageSrc']) {
      void this.reloadImage();
    }
    if (changes['keyColor'] && !changes['keyColor'].firstChange) {
      this.paint();
    }
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.endDrag();
    this.eyedropperActive.set(false);
  }

  keyColorDisplay(): string {
    return PipelineStateService.normalizeHex(this.keyColor) ?? '#00FF00';
  }

  keyRgb(): { r: number; g: number; b: number } {
    return hexToRgb(this.keyColorDisplay()) ?? { r: 0, g: 255, b: 0 };
  }

  emitKeyColor(hex: string): void {
    const n = PipelineStateService.normalizeHex(hex);
    if (!n) return;
    this.keyColorChange.emit(n);
    // Optimistic local paint before parent Input updates
    this.keyColor = n;
    this.paint();
  }

  toggleEyedropper(): void {
    if (!this.hasImage()) return;
    this.eyedropperActive.update((v) => !v);
    if (this.eyedropperActive()) {
      this.showChrome.set(false);
      this.endDrag();
    }
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.eyedropperActive()) this.eyedropperActive.set(false);
  }

  private async reloadImage(): Promise<void> {
    const src = this.imageSrc;
    const token = ++this.loadToken;
    if (!src) {
      this.img = null;
      this.imgSrcLoaded = null;
      this.hasImage.set(false);
      this.showChrome.set(false);
      this.paint();
      return;
    }
    if (src === this.imgSrcLoaded && this.img) {
      this.paint();
      this.updateOverlay();
      return;
    }
    try {
      const img = await loadImage(src);
      if (token !== this.loadToken) return;
      this.img = img;
      this.imgSrcLoaded = src;
      this.hasImage.set(true);
      this.resetPlacement(false);
      this.paint();
      this.updateOverlay();
      if (this.hovering) this.showChrome.set(true);
    } catch {
      if (token !== this.loadToken) return;
      this.img = null;
      this.imgSrcLoaded = null;
      this.hasImage.set(false);
      this.paint();
    }
  }

  /** Center image at 100% scale, 0° rotation. */
  resetPlacement(repaint = true): void {
    this.cx = CW / 2;
    this.cy = CH / 2;
    this.scale = 1;
    this.rot = 0;
    this.zoomPct.set(100);
    this.rotationDeg.set(0);
    if (repaint) {
      this.paint();
      this.updateOverlay();
    }
  }

  onZoomInput(e: Event): void {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    const pct = Number.isFinite(v) ? Math.min(300, Math.max(10, v)) : 100;
    this.zoomPct.set(pct);
    this.scale = pct / 100;
    this.paint();
    this.updateOverlay();
  }

  onStageEnter(): void {
    this.hovering = true;
    if (this.hasImage()) this.showChrome.set(true);
  }

  onStageLeave(e: PointerEvent): void {
    // Keep chrome while dragging even if pointer briefly leaves
    if (this.dragMode) return;
    const stage = this.stageRef?.nativeElement;
    const related = e.relatedTarget as Node | null;
    if (stage && related && stage.contains(related)) return;
    this.hovering = false;
    this.showChrome.set(false);
  }

  onStagePointerDown(e: PointerEvent): void {
    if (!this.img || e.button !== 0) return;
    const p = this.clientToCanvas(e.clientX, e.clientY);

    if (this.eyedropperActive()) {
      e.preventDefault();
      e.stopPropagation();
      this.sampleKeyAtCanvas(p.x, p.y);
      this.eyedropperActive.set(false);
      return;
    }

    // Allow starting a move by grabbing the image area even if chrome not shown yet
    if (!this.hitTestImage(p.x, p.y)) return;
    this.showChrome.set(true);
    this.beginMove(e);
  }

  /** Sample the painted frame (key fill + sprite) at canvas coords. */
  private sampleKeyAtCanvas(cx: number, cy: number): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    // Must match paint()'s getContext options or the browser may return null
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const x = Math.max(0, Math.min(CW - 1, Math.round(cx)));
    const y = Math.max(0, Math.min(CH - 1, Math.round(cy)));
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const hex =
      '#' +
      [pixel[0], pixel[1], pixel[2]]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    this.emitKeyColor(hex);
  }

  onBoxPointerDown(e: PointerEvent): void {
    if (!this.img || e.button !== 0) return;
    // Ignore if handle (handles stop propagation themselves)
    const t = e.target as HTMLElement;
    if (t.classList.contains('sfe-handle')) return;
    this.beginMove(e);
  }

  onRotateHandleDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.img || e.button !== 0) return;
    this.beginRotate(e);
  }

  private beginMove(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const stage = this.stageRef?.nativeElement;
    stage?.setPointerCapture(e.pointerId);
    this.dragMode = 'move';
    this.dragPointerId = e.pointerId;
    const p = this.clientToCanvas(e.clientX, e.clientY);
    this.dragStartCanvas = p;
    this.dragStartCx = this.cx;
    this.dragStartCy = this.cy;
  }

  private beginRotate(e: PointerEvent): void {
    const stage = this.stageRef?.nativeElement;
    stage?.setPointerCapture(e.pointerId);
    this.dragMode = 'rotate';
    this.dragPointerId = e.pointerId;
    const p = this.clientToCanvas(e.clientX, e.clientY);
    this.dragStartAngle = Math.atan2(p.y - this.cy, p.x - this.cx);
    this.dragStartRot = this.rot;
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(e: PointerEvent): void {
    if (!this.dragMode || e.pointerId !== this.dragPointerId) return;
    e.preventDefault();
    const p = this.clientToCanvas(e.clientX, e.clientY);
    if (this.dragMode === 'move') {
      this.cx = this.dragStartCx + (p.x - this.dragStartCanvas.x);
      this.cy = this.dragStartCy + (p.y - this.dragStartCanvas.y);
    } else if (this.dragMode === 'rotate') {
      const ang = Math.atan2(p.y - this.cy, p.x - this.cx);
      this.rot = this.dragStartRot + (ang - this.dragStartAngle);
      this.rotationDeg.set((this.rot * 180) / Math.PI);
    }
    this.paint();
    this.updateOverlay();
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointerId) return;
    this.endDrag();
  }

  private endDrag(): void {
    if (this.dragPointerId != null) {
      try {
        this.stageRef?.nativeElement.releasePointerCapture(this.dragPointerId);
      } catch {
        /* already released */
      }
    }
    this.dragMode = null;
    this.dragPointerId = null;
  }

  private clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * CW;
    const y = ((clientY - rect.top) / rect.height) * CH;
    return { x, y };
  }

  /** Point-in-OBB test for the transformed image. */
  private hitTestImage(px: number, py: number): boolean {
    if (!this.img) return false;
    const w = this.img.naturalWidth * this.scale;
    const h = this.img.naturalHeight * this.scale;
    // Translate to image-local coords
    const dx = px - this.cx;
    const dy = py - this.cy;
    const cos = Math.cos(-this.rot);
    const sin = Math.sin(-this.rot);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
  }

  private updateOverlay(): void {
    if (!this.img) {
      this.boxDisp.set({ left: 0, top: 0, width: 0, height: 0 });
      return;
    }
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / CW;
    const sy = rect.height / CH;
    const w = this.img.naturalWidth * this.scale * sx;
    const h = this.img.naturalHeight * this.scale * sy;
    // Overlay is positioned relative to stage; canvas is full stage width
    this.boxDisp.set({
      left: this.cx * sx,
      top: this.cy * sy,
      width: Math.max(8, w),
      height: Math.max(8, h),
    });
    this.rotationDeg.set((this.rot * 180) / Math.PI);
  }

  paint(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.keyColor || '#00FF00';
    ctx.fillRect(0, 0, CW, CH);

    if (this.img) {
      // Clip spill outside frame
      ctx.beginPath();
      ctx.rect(0, 0, CW, CH);
      ctx.clip();

      ctx.translate(this.cx, this.cy);
      ctx.rotate(this.rot);
      ctx.scale(this.scale, this.scale);
      ctx.drawImage(
        this.img,
        -this.img.naturalWidth / 2,
        -this.img.naturalHeight / 2,
        this.img.naturalWidth,
        this.img.naturalHeight
      );
    }
    ctx.restore();
  }

  /**
   * Export the visible frame only (chroma fill + clipped sprite).
   * Does not include control chrome.
   */
  async exportFrame(): Promise<{ blob: Blob; base64: string } | null> {
    // Paint to a clean offscreen canvas so we never capture overlay
    const off = document.createElement('canvas');
    off.width = CW;
    off.height = CH;
    const ctx = off.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = this.keyColor || '#00FF00';
    ctx.fillRect(0, 0, CW, CH);

    if (this.img) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, CW, CH);
      ctx.clip();
      ctx.translate(this.cx, this.cy);
      ctx.rotate(this.rot);
      ctx.scale(this.scale, this.scale);
      ctx.drawImage(
        this.img,
        -this.img.naturalWidth / 2,
        -this.img.naturalHeight / 2,
        this.img.naturalWidth,
        this.img.naturalHeight
      );
      ctx.restore();
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      off.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) return null;
    const base64 = await blobToBase64(blob);
    return { blob, base64 };
  }
}
