import { type ProxyConfig } from './types.js';

export class ProxyDetector {
  private config: ProxyConfig | null = null;

  detect(): ProxyConfig {
    this.config = {
      httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || undefined,
      httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || undefined,
      noProxy: this.parseNoProxy(),
    };
    return this.config;
  }

  private parseNoProxy(): string[] {
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    if (!noProxy) return [];
    return noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  getProxyForUrl(url: string): string | undefined {
    if (!this.config) {
      this.detect();
    }
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (this.config!.noProxy) {
      for (const pattern of this.config!.noProxy) {
        if (pattern === '*') return undefined;
        if (hostname === pattern || hostname.endsWith('.' + pattern)) {
          return undefined;
        }
      }
    }

    if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
      return this.config!.httpsProxy || this.config!.httpProxy;
    }
    return this.config!.httpProxy;
  }

  getProxyAgent(_url: string): undefined {
    return undefined;
  }
}
