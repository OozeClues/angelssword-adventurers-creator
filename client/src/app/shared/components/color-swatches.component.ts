import { Component, input, model, output } from '@angular/core';
import { KEY_COLORS, SwatchBadge } from '../utils/key-colors';
import { colorName } from '../utils/media';
import { PipelineStateService } from '../../core/pipeline-state.service';
import { ColorPickerComponent } from './color-picker.component';
import { hexToRgb, normalizeHex } from '../utils/color-math';

/**
 * Key / chroma color control: preset swatches, custom color, themed HSV picker,
 * hex entry, and optional system EyeDropper (via the picker popover).
 */
@Component({
  selector: 'app-color-swatches',
  imports: [ColorPickerComponent],
  template: `
    <div class="key-color-picker">
      <div class="color-swatches">
        @for (c of colors; track c.hex) {
          <div
            class="color-swatch"
            [class.selected]="normalized() === c.hex"
            [style.background]="c.hex"
            [attr.title]="c.name"
            (click)="select(c.hex)"
          >
            <span
              class="swatch-badge"
              [class.best]="badgeFor(c.hex) === 'best'"
              [class.avoid]="badgeFor(c.hex) === 'avoid'"
            >
              {{ badgeLabel(c.hex, c.name) }}
            </span>
          </div>
        }
        @if (isCustom()) {
          <div
            class="color-swatch selected color-swatch-custom"
            [style.background]="normalized()"
            title="Custom key color"
          >
            <span class="swatch-badge">Custom</span>
          </div>
        }
      </div>

      <div class="key-color-custom-row">
        <app-color-picker
          [color]="normalized()"
          (colorChange)="select($event)"
          [enableSystemEyedropper]="enableSystemEyedropper()"
          triggerTitle="Open themed color picker"
          (eyedropperError)="eyedropperError.emit($event)"
        />
        <span class="key-color-rgb text-mono text-dim" title="RGB channels">
          rgb({{ rgb().r }}, {{ rgb().g }}, {{ rgb().b }})
        </span>
      </div>
      @if (hint()) {
        <div class="text-dim mt-1" style="font-size: 0.7rem">{{ hint() }}</div>
      }
    </div>
  `,
  styles: [
    `
      .key-color-picker {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .key-color-custom-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.65rem;
      }
      .key-color-rgb {
        font-size: 0.7rem;
      }
      .color-swatch-custom {
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
      }
    `,
  ],
})
export class ColorSwatchesComponent {
  /** Selected key color (#RRGGBB). */
  readonly color = model<string>('#00FF00');
  readonly badges = input<Record<string, SwatchBadge>>({});
  readonly hint = input<string>('');
  readonly enableSystemEyedropper = input(true);
  readonly eyedropperError = output<string>();

  readonly colors = KEY_COLORS;

  readonly normalized = () =>
    PipelineStateService.normalizeHex(this.color()) ??
    normalizeHex(this.color()) ??
    '#00FF00';

  readonly isCustom = () => !KEY_COLORS.some((c) => c.hex === this.normalized());

  readonly rgb = () => hexToRgb(this.normalized()) ?? { r: 0, g: 255, b: 0 };

  select(hex: string): void {
    const n = PipelineStateService.normalizeHex(hex) ?? normalizeHex(hex);
    if (n) this.color.set(n);
  }

  badgeFor(hex: string): SwatchBadge {
    return this.badges()[hex] ?? 'default';
  }

  badgeLabel(hex: string, name: string): string {
    const b = this.badgeFor(hex);
    if (b === 'best') return '⭐ Best';
    if (b === 'avoid') return '⚠ Avoid';
    return name || colorName(hex);
  }
}
