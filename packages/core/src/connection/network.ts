import dns from 'node:dns/promises';
import net from 'node:net';
import type { Endpoint } from './types.js';

export class NetworkResolver {
  async resolveEndpoint(host: string, preferIPv4: boolean = true): Promise<Endpoint> {
    const errors: Error[] = [];

    if (preferIPv4) {
      try {
        const addresses = await dns.resolve4(host);
        if (addresses.length > 0) {
          return { host, address: addresses[0], family: 4, protocol: "ipv4" as const };
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }

      try {
        const addresses = await dns.resolve6(host);
        if (addresses.length > 0) {
          return { host, address: addresses[0], family: 6, protocol: "ipv6" as const };
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    } else {
      try {
        const addresses = await dns.resolve6(host);
        if (addresses.length > 0) {
          return { host, address: addresses[0], family: 6, protocol: "ipv6" as const };
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }

      try {
        const addresses = await dns.resolve4(host);
        if (addresses.length > 0) {
          return { host, address: addresses[0], family: 4, protocol: "ipv4" as const };
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }

    throw new AggregateError(errors, `Failed to resolve host: ${host}`);
  }

  isReachable(host: string, port: number, timeout: number = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeout);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
    });
  }
}
