import { Injectable, signal } from '@angular/core';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  show: boolean;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);

  show(message: string, type: ToastType = 'info'): void {
    const id = this.nextId++;
    this.toasts.update((list) => [...list, { id, message, type, show: false }]);

    requestAnimationFrame(() => {
      this.toasts.update((list) => list.map((t) => (t.id === id ? { ...t, show: true } : t)));
    });

    setTimeout(() => {
      this.toasts.update((list) => list.map((t) => (t.id === id ? { ...t, show: false } : t)));
      setTimeout(() => {
        this.toasts.update((list) => list.filter((t) => t.id !== id));
      }, 400);
    }, 3500);
  }
}
