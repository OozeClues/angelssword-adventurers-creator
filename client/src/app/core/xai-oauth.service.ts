import { Injectable, signal } from '@angular/core';

/**
 * SuperGrok / X Premium+ device-code OAuth for Grok Imagine.
 * Tokens live only in browser localStorage and are sent only to auth.x.ai / api.x.ai
 * via the local proxy.
 */

export const XAI_OAUTH_STORAGE_KEY = 'xai_oauth_tokens';

export interface XaiOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  obtained_at: number;
}

export type XaiOAuthLoginProgress =
  | string
  | {
      type: 'device_code';
      url: string;
      user_code: string;
      message: string;
    };

export interface XaiOAuthStatus {
  loggedIn: boolean;
  expiresAt?: number;
  obtainedAt?: number;
  hasRefresh?: boolean;
}

@Injectable({ providedIn: 'root' })
export class XaiOAuthService {
  /** Bumps when login/logout/refresh changes stored tokens (for computed readiness). */
  readonly authEpoch = signal(0);

  loadTokens(): XaiOAuthTokens | null {
    try {
      const raw = localStorage.getItem(XAI_OAUTH_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as XaiOAuthTokens;
    } catch {
      return null;
    }
  }

  saveTokens(tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
  }): void {
    const payload: XaiOAuthTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at || Date.now() + (tokens.expires_in || 3600) * 1000,
      obtained_at: Date.now(),
    };
    // Preserve refresh_token if refresh response omitted it
    if (!payload.refresh_token) {
      const prev = this.loadTokens();
      if (prev?.refresh_token) payload.refresh_token = prev.refresh_token;
    }
    localStorage.setItem(XAI_OAUTH_STORAGE_KEY, JSON.stringify(payload));
    this.authEpoch.update((n) => n + 1);
  }

  clearTokens(): void {
    localStorage.removeItem(XAI_OAUTH_STORAGE_KEY);
    this.authEpoch.update((n) => n + 1);
  }

  isTokenExpiring(tokens: XaiOAuthTokens | null, skewSec = 300): boolean {
    if (!tokens?.expires_at) return true;
    return Date.now() >= tokens.expires_at - skewSec * 1000;
  }

  isLoggedIn(): boolean {
    const t = this.loadTokens();
    return !!(t && t.access_token);
  }

  getStatus(): XaiOAuthStatus {
    // Read epoch so Angular recomputes dependents when tokens change
    this.authEpoch();
    const t = this.loadTokens();
    if (!t?.access_token) return { loggedIn: false };
    return {
      loggedIn: true,
      expiresAt: t.expires_at,
      obtainedAt: t.obtained_at,
      hasRefresh: !!t.refresh_token,
    };
  }

  private async requestDeviceCode(): Promise<{
    device_code: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  }> {
    const resp = await fetch('/api/xai/oauth/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({} as { error?: string }));
      throw new Error(err.error || `Device code request failed: ${resp.status}`);
    }
    return resp.json();
  }

  private async pollForToken(
    deviceCode: string,
    intervalSec = 5,
    signal?: AbortSignal
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    };

    let interval = intervalSec || 5;

    while (true) {
      if (signal?.aborted) {
        throw new Error('Login cancelled');
      }

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), interval * 1000);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error('Login cancelled'));
          };
          if (signal.aborted) {
            clearTimeout(t);
            reject(new Error('Login cancelled'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      if (signal?.aborted) {
        throw new Error('Login cancelled');
      }

      const resp = await fetch('/api/xai/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (resp.ok && data.access_token) {
        return data as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
      }

      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        interval = (interval || 5) + 2;
        continue;
      }
      if (data.error === 'expired_token') {
        throw new Error('Device code expired. Please try logging in again.');
      }
      if (data.error === 'access_denied') {
        throw new Error('You denied the login request.');
      }
      throw new Error(
        data.error_description || data.error || `Token poll failed: ${resp.status}`
      );
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const resp = await fetch('/api/xai/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      throw new Error(
        err.error_description || err.error || `Refresh failed: ${resp.status}`
      );
    }
    return resp.json();
  }

  /**
   * Full device-code login. Pass AbortSignal to cancel waiting for browser approval.
   */
  async login(
    onProgress?: (info: XaiOAuthLoginProgress) => void,
    signal?: AbortSignal
  ): Promise<XaiOAuthTokens> {
    onProgress?.('Requesting device code from xAI...');
    const device = await this.requestDeviceCode();

    if (signal?.aborted) throw new Error('Login cancelled');

    const uri = device.verification_uri_complete || device.verification_uri || '';
    const userCode = device.user_code || '';

    onProgress?.({
      type: 'device_code',
      url: uri,
      user_code: userCode,
      message: `Open ${uri} and enter code: ${userCode}`,
    });

    try {
      if (uri) window.open(uri, '_blank');
    } catch {
      /* popup blocked — user can click the link */
    }

    onProgress?.('Waiting for you to approve in the browser...');
    const tokens = await this.pollForToken(device.device_code, device.interval, signal);

    const expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;
    this.saveTokens({ ...tokens, expires_at });
    onProgress?.('Login successful! SuperGrok session active.');
    return this.loadTokens()!;
  }

  /**
   * Returns a valid access token, refreshing when near expiry.
   * Returns null if not logged in or refresh fails (tokens cleared).
   */
  async getAccessToken(): Promise<string | null> {
    let tokens = this.loadTokens();
    if (!tokens?.access_token) return null;

    if (this.isTokenExpiring(tokens) && tokens.refresh_token) {
      try {
        const refreshed = await this.refreshAccessToken(tokens.refresh_token);
        const expires_at = Date.now() + (refreshed.expires_in || 3600) * 1000;
        this.saveTokens({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || tokens.refresh_token,
          expires_at,
        });
        tokens = this.loadTokens();
      } catch (e) {
        console.warn('[xAI OAuth] Refresh failed, clearing tokens:', (e as Error).message);
        this.clearTokens();
        return null;
      }
    }

    return tokens?.access_token ?? null;
  }

  logout(): void {
    this.clearTokens();
  }

  /**
   * Force a refresh attempt (Settings "Refresh Token").
   */
  async forceRefresh(): Promise<string | null> {
    const tokens = this.loadTokens();
    if (!tokens?.refresh_token) {
      // No refresh — just return current if any
      return this.getAccessToken();
    }
    // Mark expired so getAccessToken refreshes
    tokens.expires_at = 0;
    localStorage.setItem(XAI_OAUTH_STORAGE_KEY, JSON.stringify(tokens));
    return this.getAccessToken();
  }
}
