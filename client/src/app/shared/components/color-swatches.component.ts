import { Component, input, model } from '@angular/core';
import { KEY_COLORS, SwatchBadge } from '../utils/key-colors';
import { colorName } from '../utils/media';

@Component({
  selector: 'app-color-swatches',
  template: `
    <div class="color-swatches">
      @for (c of colors; track c.hex) {
        <div
          class="color-swatch"
          [class.selected]="color() === c.hex"
          [style.background]="c.hex"
          [attr.title]="c.name"
          (click)="select(c.hex)"
        >
          <span class="swatch-badge" [class.best]="badgeFor(c.hex) === 'best'" [class.avoid]="badgeFor(c.hex) === 'avoid'">
            {{ badgeLabel(c.hex, c.name) }}
          </span>
        </div>
      }
    </div>
  `,
})
export class ColorSwatchesComponent {
  readonly color = model<string>('#00FF00');
  readonly badges = input<Record<string, SwatchBadge>>({});

  readonly colors = KEY_COLORS;

  select(hex: string): void {
    this.color.set(hex);
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
