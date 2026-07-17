import { Injectable } from '@angular/core';

type CancelHandler = () => void;

/**
 * Lets feature tabs register cancel handlers for Escape-key cancellation.
 */
@Injectable({ providedIn: 'root' })
export class CancelService {
  private handlers = new Set<CancelHandler>();

  register(handler: CancelHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  cancelAll(): void {
    for (const h of [...this.handlers]) h();
  }
}
