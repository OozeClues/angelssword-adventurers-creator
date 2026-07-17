import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keep pipeline tab components mounted across navigation.
 *
 * The original vanilla app used CSS tab panels (never destroyed). Angular's
 * default router tears down each feature on leave, which:
 *  - unloads videos / revokes blob URLs mid-session
 *  - breaks Video Prep → Exporter handoff (blob: URL already revoked)
 *  - loses scrub position, loop settings, frame cache, etc.
 */
@Injectable()
export class PipelineRouteReuseStrategy implements RouteReuseStrategy {
  private readonly handles = new Map<string, DetachedRouteHandle>();

  /** Routes that behave like sticky SPA tabs. */
  private static readonly STICKY = new Set([
    'sprite-prep',
    'video-gen',
    'video-prep',
    'export',
    'settings',
  ]);

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isSticky(route);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.key(route);
    if (!key) return;
    if (handle) this.handles.set(key, handle);
    else this.handles.delete(key);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.key(route);
    return !!key && this.handles.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.key(route);
    return key ? this.handles.get(key) ?? null : null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  private isSticky(route: ActivatedRouteSnapshot): boolean {
    const path = route.routeConfig?.path;
    return !!path && PipelineRouteReuseStrategy.STICKY.has(path);
  }

  private key(route: ActivatedRouteSnapshot): string | null {
    const path = route.routeConfig?.path;
    return path && PipelineRouteReuseStrategy.STICKY.has(path) ? path : null;
  }
}
