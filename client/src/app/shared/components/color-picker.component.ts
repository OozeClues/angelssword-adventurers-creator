import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  ViewEncapsulation,
  effect,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import {
  clamp,
  hexToRgb,
  hsvToHex,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  type Hsv,
} from '../utils/color-math';

/**
 * Themed in-app HSV color picker (popover).
 * Panel is portaled to document.body so parent overflow / backdrop-filter
 * cannot clip or trap it.
 */
@Component({
  selector: 'app-color-picker',
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="cp" [class.cp-open]="open()">
      <button
        #triggerBtn
        type="button"
        class="cp-trigger"
        [attr.aria-expanded]="open()"
        [attr.title]="triggerTitle()"
        (click)="toggle($event)"
      >
        <span class="cp-trigger-swatch" [style.background]="hex()"></span>
        <span class="cp-trigger-label">{{ hex() }}</span>
        <span class="cp-trigger-caret">▾</span>
      </button>
    </div>

    @if (open()) {
      <div
        #popoverEl
        class="cp-popover"
        role="dialog"
        aria-label="Color picker"
        [style.top.px]="popoverPos().top"
        [style.left.px]="popoverPos().left"
        (click)="$event.stopPropagation()"
        (pointerdown)="$event.stopPropagation()"
      >
        <div class="cp-popover-title">
          <span class="title-icon">🎨</span> Color
          <button type="button" class="cp-close" title="Close" (click)="close()">✕</button>
        </div>

        <div
          class="cp-sv"
          #svPlane
          [style.background]="
            'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' +
            hue() +
            ' 100% 50%))'
          "
          (pointerdown)="onSvDown($event)"
        >
          <div
            class="cp-sv-thumb"
            [style.left.%]="sat() * 100"
            [style.top.%]="(1 - val()) * 100"
          ></div>
        </div>

        <div class="cp-hue" #hueBar (pointerdown)="onHueDown($event)">
          <div class="cp-hue-track"></div>
          <div class="cp-hue-thumb" [style.left.%]="(hue() / 360) * 100"></div>
        </div>

        <div class="cp-preview-row">
          <div class="cp-preview" [style.background]="hex()" [title]="hex()"></div>
          <div class="cp-fields">
            <label class="cp-field">
              <span>Hex</span>
              <input
                type="text"
                maxlength="7"
                spellcheck="false"
                [value]="hex()"
                (change)="onHexInput($event)"
                (keydown.enter)="onHexInput($event)"
              />
            </label>
            <div class="cp-rgb-row">
              <label class="cp-field cp-field-sm">
                <span>R</span>
                <input
                  type="number"
                  min="0"
                  max="255"
                  [value]="rgb().r"
                  (change)="onRgbInput('r', $event)"
                />
              </label>
              <label class="cp-field cp-field-sm">
                <span>G</span>
                <input
                  type="number"
                  min="0"
                  max="255"
                  [value]="rgb().g"
                  (change)="onRgbInput('g', $event)"
                />
              </label>
              <label class="cp-field cp-field-sm">
                <span>B</span>
                <input
                  type="number"
                  min="0"
                  max="255"
                  [value]="rgb().b"
                  (change)="onRgbInput('b', $event)"
                />
              </label>
            </div>
          </div>
        </div>

        @if (showSystemEyedropper()) {
          <button
            type="button"
            class="btn btn-sm btn-secondary cp-sys-drop"
            [disabled]="dropperBusy()"
            (click)="openSystemEyedropper()"
          >
            💧 Sample from screen
          </button>
        }
      </div>
    }
  `,
  styles: [
    `
      .cp {
        position: relative;
        display: inline-flex;
        vertical-align: middle;
      }
      .cp-trigger {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px 4px 4px;
        border-radius: var(--radius, 8px);
        border: 1px solid var(--border-light, rgba(255, 255, 255, 0.12));
        background: rgba(255, 255, 255, 0.04);
        color: var(--text, #e0e0e0);
        font-family: var(--font-mono, monospace);
        font-size: 0.8rem;
        cursor: pointer;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .cp-trigger:hover,
      .cp-open .cp-trigger {
        border-color: var(--accent-gold, #dbb858);
        box-shadow: 0 0 10px var(--accent-gold-glow, rgba(219, 184, 88, 0.25));
      }
      .cp-trigger-swatch {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        border: 1px solid rgba(0, 0, 0, 0.35);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
        flex-shrink: 0;
      }
      .cp-trigger-label {
        letter-spacing: 0.04em;
        min-width: 4.5rem;
      }
      .cp-trigger-caret {
        opacity: 0.55;
        font-size: 0.7rem;
      }
      /* Portaled to body — true viewport fixed layer */
      .cp-popover {
        position: fixed !important;
        z-index: 2147483000 !important;
        width: min(280px, calc(100vw - 16px));
        max-height: min(420px, calc(100vh - 16px));
        overflow-x: hidden;
        overflow-y: auto;
        padding: 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        margin: 0;
        box-sizing: border-box;
        border-radius: var(--radius-lg, 12px);
        border: 1px solid rgba(219, 184, 88, 0.35);
        background: rgba(22, 33, 62, 0.98);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(0, 0, 0, 0.25);
        color: var(--text, #e0e0e0);
        font-family: var(--font-body, 'Outfit', sans-serif);
      }
      .cp-popover-title {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-family: var(--font-heading, Cinzel, serif);
        font-size: 0.85rem;
        color: var(--accent-gold, #dbb858);
        letter-spacing: 0.04em;
      }
      .cp-close {
        margin-left: auto;
        border: none;
        background: transparent;
        color: var(--text-muted, #8899aa);
        cursor: pointer;
        font-size: 0.9rem;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .cp-close:hover {
        color: var(--text-bright, #fff);
        background: rgba(255, 255, 255, 0.06);
      }
      .cp-sv {
        position: relative;
        width: 100%;
        aspect-ratio: 1.15 / 1;
        border-radius: var(--radius, 8px);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        cursor: crosshair;
        touch-action: none;
        overflow: hidden;
        flex-shrink: 0;
      }
      .cp-sv-thumb {
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid #fff;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 1px 4px rgba(0, 0, 0, 0.45);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }
      .cp-hue {
        position: relative;
        height: 16px;
        border-radius: 999px;
        cursor: pointer;
        touch-action: none;
        overflow: visible;
        flex-shrink: 0;
      }
      .cp-hue-track {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: linear-gradient(
          to right,
          #f00 0%,
          #ff0 17%,
          #0f0 33%,
          #0ff 50%,
          #00f 67%,
          #f0f 83%,
          #f00 100%
        );
        border: 1px solid rgba(0, 0, 0, 0.25);
      }
      .cp-hue-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        border: 2px solid #1a1a2e;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 1;
      }
      .cp-preview-row {
        display: flex;
        gap: 0.65rem;
        align-items: stretch;
      }
      .cp-preview {
        width: 52px;
        flex-shrink: 0;
        border-radius: var(--radius, 8px);
        border: 1px solid var(--border-light, rgba(255, 255, 255, 0.12));
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
      }
      .cp-fields {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        min-width: 0;
      }
      .cp-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin: 0;
        font-size: 0.65rem;
        color: var(--text-muted, #8899aa);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .cp-field input {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 7px;
        border-radius: 6px;
        border: 1px solid var(--border-light, rgba(255, 255, 255, 0.12));
        background: var(--bg-input, #0f1a30);
        color: var(--text, #e0e0e0);
        font-family: var(--font-mono, monospace);
        font-size: 0.8rem;
        text-transform: uppercase;
      }
      .cp-field input:focus {
        outline: none;
        border-color: var(--accent-gold, #dbb858);
      }
      .cp-rgb-row {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 0.35rem;
      }
      .cp-field-sm input {
        padding: 4px 4px;
        text-align: center;
      }
      .cp-sys-drop {
        width: 100%;
        justify-content: center;
      }
    `,
  ],
})
export class ColorPickerComponent implements OnDestroy {
  @ViewChild('svPlane') svPlane?: ElementRef<HTMLElement>;
  @ViewChild('hueBar') hueBar?: ElementRef<HTMLElement>;
  @ViewChild('triggerBtn') triggerBtn?: ElementRef<HTMLButtonElement>;

  private popoverNode: HTMLElement | null = null;

  @ViewChild('popoverEl')
  set popoverElRef(ref: ElementRef<HTMLElement> | undefined) {
    // Detach previous portal node if Angular recycled the view
    if (this.popoverNode && this.popoverNode !== ref?.nativeElement) {
      this.popoverNode.remove();
      this.popoverNode = null;
    }
    if (ref?.nativeElement) {
      this.popoverNode = ref.nativeElement;
      // Escape stacking contexts (glass-panel backdrop-filter, overflow, etc.)
      if (this.popoverNode.parentElement !== document.body) {
        document.body.appendChild(this.popoverNode);
      }
      requestAnimationFrame(() => {
        this.reposition();
        requestAnimationFrame(() => this.reposition());
      });
    }
  }

  /** Two-way selected color (#RRGGBB). */
  readonly color = model<string>('#00FF00');
  readonly triggerTitle = input('Open color picker');
  readonly enableSystemEyedropper = input(true);
  readonly eyedropperError = output<string>();

  readonly open = signal(false);
  readonly dropperBusy = signal(false);
  readonly popoverPos = signal({ top: 8, left: 8 });

  readonly hue = signal(120);
  readonly sat = signal(1);
  readonly val = signal(1);

  private dragKind: 'sv' | 'hue' | null = null;
  private dragPointerId: number | null = null;
  private syncingFromModel = false;
  private readonly onScrollCapture = () => {
    if (this.open()) this.reposition();
  };

  constructor(private readonly host: ElementRef<HTMLElement>) {
    effect(() => {
      const hex = normalizeHex(this.color()) ?? '#00FF00';
      if (this.syncingFromModel) return;
      const rgb = hexToRgb(hex);
      if (!rgb) return;
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      this.applyHsv(hsv, false);
    });
    document.addEventListener('scroll', this.onScrollCapture, true);
  }

  ngOnDestroy(): void {
    document.removeEventListener('scroll', this.onScrollCapture, true);
    this.endDrag();
    this.popoverNode?.remove();
    this.popoverNode = null;
  }

  hex(): string {
    return normalizeHex(this.color()) ?? '#00FF00';
  }

  rgb() {
    return hexToRgb(this.hex()) ?? { r: 0, g: 255, b: 0 };
  }

  showSystemEyedropper(): boolean {
    return this.enableSystemEyedropper() && typeof window !== 'undefined' && 'EyeDropper' in window;
  }

  toggle(e: Event): void {
    e.stopPropagation();
    const next = !this.open();
    this.open.set(next);
    if (!next) {
      this.endDrag();
      // @if will destroy; ensure portal is cleaned if still attached
      queueMicrotask(() => {
        if (!this.open()) {
          this.popoverNode?.remove();
          this.popoverNode = null;
        }
      });
    }
  }

  close(): void {
    this.open.set(false);
    this.endDrag();
    queueMicrotask(() => {
      this.popoverNode?.remove();
      this.popoverNode = null;
    });
  }

  /**
   * Prefer opening *above* the trigger when there is more room there or the
   * trigger sits in the lower half of the viewport (handoff buttons below).
   */
  reposition(): void {
    if (!this.open()) return;
    const trigger = this.triggerBtn?.nativeElement;
    const pop = this.popoverNode;
    if (!trigger || !pop) return;

    const gap = 8;
    const margin = 8;
    const tr = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth || Math.min(280, window.innerWidth - margin * 2);
    const ph = pop.offsetHeight || 360;

    const spaceBelow = window.innerHeight - tr.bottom - gap - margin;
    const spaceAbove = tr.top - gap - margin;
    const preferAbove =
      spaceAbove >= ph ||
      (spaceAbove > spaceBelow && spaceBelow < ph) ||
      tr.top > window.innerHeight * 0.42;

    let top: number;
    if (preferAbove) {
      top = tr.top - gap - ph;
      if (top < margin) {
        // Not enough room above either — pin to top and allow internal scroll
        top = margin;
      }
    } else {
      top = tr.bottom + gap;
      if (top + ph > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - ph - margin);
      }
    }

    let left = tr.left;
    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - pw - margin;
    }
    left = clamp(left, margin, Math.max(margin, window.innerWidth - pw - margin));
    top = clamp(top, margin, Math.max(margin, window.innerHeight - Math.min(ph, window.innerHeight - margin * 2) - margin));

    this.popoverPos.set({ top, left });
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.open()) this.reposition();
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocPointerDown(e: PointerEvent): void {
    if (!this.open()) return;
    const t = e.target as Node;
    if (this.host.nativeElement.contains(t)) return;
    if (this.popoverNode?.contains(t)) return;
    this.close();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open()) this.close();
  }

  private applyHsv(hsv: Hsv, emit: boolean): void {
    this.hue.set(hsv.h);
    this.sat.set(hsv.s);
    this.val.set(hsv.v);
    if (emit) {
      const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
      this.syncingFromModel = true;
      this.color.set(hex);
      queueMicrotask(() => {
        this.syncingFromModel = false;
      });
    }
  }

  private commitFromHsv(): void {
    this.applyHsv({ h: this.hue(), s: this.sat(), v: this.val() }, true);
  }

  onSvDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = this.svPlane?.nativeElement;
    el?.setPointerCapture(e.pointerId);
    this.dragKind = 'sv';
    this.dragPointerId = e.pointerId;
    this.updateSvFromEvent(e);
  }

  onHueDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = this.hueBar?.nativeElement;
    el?.setPointerCapture(e.pointerId);
    this.dragKind = 'hue';
    this.dragPointerId = e.pointerId;
    this.updateHueFromEvent(e);
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(e: PointerEvent): void {
    if (!this.dragKind || e.pointerId !== this.dragPointerId) return;
    e.preventDefault();
    if (this.dragKind === 'sv') this.updateSvFromEvent(e);
    else this.updateHueFromEvent(e);
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
        this.svPlane?.nativeElement.releasePointerCapture(this.dragPointerId);
      } catch {
        /* */
      }
      try {
        this.hueBar?.nativeElement.releasePointerCapture(this.dragPointerId);
      } catch {
        /* */
      }
    }
    this.dragKind = null;
    this.dragPointerId = null;
  }

  private updateSvFromEvent(e: PointerEvent): void {
    const el = this.svPlane?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    this.sat.set(x);
    this.val.set(1 - y);
    this.commitFromHsv();
  }

  private updateHueFromEvent(e: PointerEvent): void {
    const el = this.hueBar?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    this.hue.set(x * 360);
    this.commitFromHsv();
  }

  onHexInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const n = normalizeHex(el.value);
    if (n) {
      this.color.set(n);
      const rgb = hexToRgb(n)!;
      this.applyHsv(rgbToHsv(rgb.r, rgb.g, rgb.b), false);
      el.value = n;
    } else {
      el.value = this.hex();
    }
  }

  onRgbInput(channel: 'r' | 'g' | 'b', e: Event): void {
    const raw = parseInt((e.target as HTMLInputElement).value, 10);
    const cur = this.rgb();
    const next = { ...cur, [channel]: clamp(Number.isFinite(raw) ? raw : cur[channel], 0, 255) };
    const hex = rgbToHex(next.r, next.g, next.b);
    this.color.set(hex);
    this.applyHsv(rgbToHsv(next.r, next.g, next.b), false);
  }

  async openSystemEyedropper(): Promise<void> {
    if (!this.showSystemEyedropper() || this.dropperBusy()) return;
    this.dropperBusy.set(true);
    try {
      const EyeDropperCtor = (
        window as unknown as {
          EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> };
        }
      ).EyeDropper;
      const result = await new EyeDropperCtor().open();
      const n = normalizeHex(result.sRGBHex);
      if (n) {
        this.color.set(n);
        const rgb = hexToRgb(n)!;
        this.applyHsv(rgbToHsv(rgb.r, rgb.g, rgb.b), false);
      }
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      if (!/abort|cancel/i.test(msg)) this.eyedropperError.emit(msg);
    } finally {
      this.dropperBusy.set(false);
    }
  }
}
