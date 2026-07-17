import { Component, input, model } from '@angular/core';

export interface ModeOption {
  value: string;
  label: string;
  title?: string;
  /** When true, button is shown but not selectable. */
  disabled?: boolean;
}

@Component({
  selector: 'app-mode-selector',
  template: `
    <div [class]="containerClass()">
      @for (opt of options(); track opt.value) {
        <button
          type="button"
          [class]="buttonClass()"
          [class.active]="value() === opt.value"
          [class.disabled]="!!opt.disabled"
          [disabled]="!!opt.disabled"
          [attr.title]="opt.title || opt.label"
          (click)="select(opt)"
        >
          {{ opt.label }}
        </button>
      }
    </div>
  `,
})
export class ModeSelectorComponent {
  readonly options = input.required<ModeOption[]>();
  readonly value = model<string>('');
  readonly variant = input<'mode' | 'seg' | 'export'>('mode');

  containerClass(): string {
    if (this.variant() === 'seg') return 'seg-toggle';
    if (this.variant() === 'export') return 'export-mode-toggle';
    return 'mode-selector';
  }

  buttonClass(): string {
    if (this.variant() === 'seg') return 'seg-btn';
    if (this.variant() === 'export') return 'export-mode-btn';
    return 'mode-btn';
  }

  select(opt: ModeOption): void {
    if (opt.disabled) return;
    this.value.set(opt.value);
  }
}
