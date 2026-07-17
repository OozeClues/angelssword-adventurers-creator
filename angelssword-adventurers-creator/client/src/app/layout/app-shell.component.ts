import { Component, ElementRef, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ToastHostComponent } from '../shared/components/toast-host.component';
import { CancelService } from '../core/cancel.service';
import { NotificationSoundService } from '../core/notification-sound.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  step?: string;
  title: string;
  pipeline?: boolean;
}

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastHostComponent],
  template: `
    <div class="app-container">
      <header class="app-header">
        <div class="brand">
          <img src="assets/Angelsword-Logo-white_25pct.webp" alt="Angel's Sword Studios" class="brand-logo" />
          <div>
            <div class="brand-name">AS Adventurer Creator</div>
            <div class="brand-tagline">Design · Generate · Prepare · Export</div>
          </div>
        </div>

        <nav class="pipeline-steps">
          @for (item of pipeline; track item.path; let last = $last) {
            <a
              class="step"
              [routerLink]="item.path"
              routerLinkActive="active"
              [attr.title]="item.title"
            >
              <span class="step-badge">{{ item.step }}</span> {{ item.label }}
            </a>
            @if (!last) {
              <span class="step-arrow">→</span>
            }
          }
        </nav>
      </header>

      <nav class="tab-bar">
        @for (item of tabs; track item.path) {
          <a
            class="tab-btn"
            [routerLink]="item.path"
            routerLinkActive="active"
            [attr.title]="item.title"
          >
            <span class="tab-icon">{{ item.icon }}</span>
            <span class="tab-label">{{ item.label }}</span>
          </a>
        }
      </nav>

      <div class="tab-content" #tabContent>
        <div class="tab-panel active">
          <router-outlet />
        </div>
      </div>
    </div>

    <app-toast-host />
  `,
  styles: [
    `
      a.tab-btn,
      a.step {
        text-decoration: none;
        color: inherit;
        cursor: pointer;
      }
    `,
  ],
})
export class AppShellComponent implements OnInit, OnDestroy {
  private readonly cancel = inject(CancelService);
  private readonly host = inject(ElementRef<HTMLElement>);
  // Eagerly construct sound service so gesture listeners bind.
  private readonly _sound = inject(NotificationSoundService);

  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  readonly pipeline: NavItem[] = [
    { path: '/sprite-prep', label: 'Sprite Prep', icon: '🎨', step: '①', title: 'Create or prepare a sprite', pipeline: true },
    { path: '/video-gen', label: 'Generate Video', icon: '🎬', step: '②', title: 'Generate animated videos', pipeline: true },
    { path: '/video-prep', label: 'Video Prep', icon: '🔄', step: '③', title: 'Build loops and prepare video', pipeline: true },
    { path: '/export', label: 'Export', icon: '📦', step: '④', title: 'Export transparent motion', pipeline: true },
  ];

  readonly tabs: NavItem[] = [
    ...this.pipeline.map((p) =>
      p.path === '/export'
        ? { ...p, label: 'Model Exporter', title: 'Export as transparent WebM or GIF' }
        : p
    ),
    { path: '/settings', label: 'Settings', icon: '⚙️', title: 'API keys, server settings, and about' },
  ];

  ngOnInit(): void {
    // Wheel on side gutters (outside the max-width column) should still scroll
    // main content. Native scrolling only hits .tab-content's box.
    this.wheelHandler = (e: WheelEvent) => this.forwardGutterWheel(e);
    document.addEventListener('wheel', this.wheelHandler, { passive: false, capture: true });
  }

  ngOnDestroy(): void {
    if (this.wheelHandler) {
      document.removeEventListener('wheel', this.wheelHandler, true);
      this.wheelHandler = null;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return;
    if (e.key === 'Escape') this.cancel.cancelAll();
  }

  /**
   * When the user scrolls over the large left/right gutters (or other
   * non-scrollable chrome), apply deltaY to the main .tab-content scroller.
   */
  private forwardGutterWheel(e: WheelEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;

    const tabContent = this.host.nativeElement.querySelector(
      '.tab-content'
    ) as HTMLElement | null;
    if (!tabContent) return;

    const target = e.target as Node | null;
    if (!target) return;

    // Already over the main scroller — let the browser handle it.
    if (tabContent.contains(target)) {
      // Unless nested inside a different overflow:auto region (e.g. sidebar).
      const nested = this.findScrollableAncestor(target as Element, tabContent);
      if (!nested || nested === tabContent) return;
      // Nested scrollable: only forward if it can't scroll further in this direction.
      if (this.canScroll(nested, e.deltaY)) return;
    } else {
      // Outside tab-content: if over some other scrollable, respect it first.
      const nested = this.findScrollableAncestor(target as Element, document.body);
      if (nested && nested !== document.documentElement && nested !== document.body) {
        if (this.canScroll(nested, e.deltaY)) return;
      }
    }

    if (!this.canScroll(tabContent, e.deltaY)) return;

    tabContent.scrollTop += e.deltaY;
    e.preventDefault();
  }

  private findScrollableAncestor(start: Element | null, stopAt: Element | null): HTMLElement | null {
    let el: Element | null = start;
    while (el && el !== stopAt) {
      if (el instanceof HTMLElement && this.isScrollable(el)) return el;
      el = el.parentElement;
    }
    if (stopAt instanceof HTMLElement && this.isScrollable(stopAt)) return stopAt;
    return null;
  }

  private isScrollable(el: HTMLElement): boolean {
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  private canScroll(el: HTMLElement, deltaY: number): boolean {
    if (!this.isScrollable(el)) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return false;
    if (deltaY < 0 && el.scrollTop > 0) return true;
    if (deltaY > 0 && el.scrollTop < max - 0.5) return true;
    return false;
  }
}
