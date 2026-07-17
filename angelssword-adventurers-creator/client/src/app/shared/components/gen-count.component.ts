import { Component, model } from '@angular/core';

@Component({
  selector: 'app-gen-count',
  template: `
    <div class="gen-count">
      @for (n of counts; track n) {
        <button
          type="button"
          class="gen-count-btn"
          [class.active]="count() === n"
          [attr.title]="'Generate ' + n"
          (click)="select(n)"
        >
          {{ n }}
        </button>
      }
    </div>
  `,
})
export class GenCountComponent {
  readonly count = model(1);
  readonly counts = [1, 2, 3, 4];

  select(n: number): void {
    this.count.set(n);
  }
}
