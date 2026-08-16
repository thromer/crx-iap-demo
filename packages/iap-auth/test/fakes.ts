import type { Authorizer, Clock, KeyValueStore } from '../src/types.ts';

export function inMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export class FakeClock implements Clock {
  private time: number;

  constructor(initial = Date.now()) {
    this.time = initial;
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  set(ms: number): void {
    this.time = ms;
  }
}

/**
 * Drives the real authorization server's interaction flow over plain HTTP requests (no
 * browser): follows redirects, submits the approve form when `forceLogin` is armed, and stops
 * as soon as it lands on `redirectUri`, returning that URL for the module to validate — same
 * contract `chrome.identity.launchWebAuthFlow` fulfills in the extension.
 */
export function createHttpAuthorizer(redirectUri: string): Authorizer {
  return {
    redirectUri: () => redirectUri,
    async authorize(url) {
      const redirectOrigin = new URL(redirectUri).origin;
      const cookies = new Map<string, string>();

      function cookieHeader(): string {
        return Array.from(cookies, ([k, v]) => `${k}=${v}`).join('; ');
      }
      function captureCookies(response: Response): void {
        for (const setCookie of response.headers.getSetCookie?.() ?? []) {
          const pair = setCookie.split(';', 1)[0];
          const eq = pair?.indexOf('=') ?? -1;
          if (pair && eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
      }
      async function get(target: URL): Promise<Response> {
        const res = await fetch(target, {
          redirect: 'manual',
          headers: { cookie: cookieHeader() },
        });
        captureCookies(res);
        return res;
      }
      async function post(target: URL): Promise<Response> {
        const res = await fetch(target, {
          method: 'POST',
          redirect: 'manual',
          headers: { cookie: cookieHeader() },
        });
        captureCookies(res);
        return res;
      }

      let current = new URL(url);
      let response = await get(current);

      for (let i = 0; i < 10; i++) {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error(`redirect from ${current} carried no Location header`);
          const next = new URL(location, current);
          if (next.origin === redirectOrigin) return next.toString();
          current = next;
          response = await get(current);
          continue;
        }
        if (response.status === 200) {
          const html = await response.text();
          const match = html.match(/action="([^"]+)"/);
          if (!match) throw new Error(`unexpected 200 page from ${current} while authorizing`);
          current = new URL(match[1] as string, current);
          response = await post(current);
          continue;
        }
        throw new Error(`unexpected ${response.status} response from ${current} while authorizing`);
      }
      throw new Error('too many redirects while authorizing');
    },
  };
}

/**
 * Wraps a real authorizer so tests can force the silent leg of the ladder to fail without
 * needing a real "no SSO session" condition from the AS.
 */
export function createLadderTestAuthorizer(
  inner: Authorizer,
): Authorizer & { failSilentOnce: boolean } {
  const wrapper = {
    failSilentOnce: false,
    redirectUri: () => inner.redirectUri(),
    async authorize(url: string, opts: { interactive: boolean }) {
      if (!opts.interactive && wrapper.failSilentOnce) {
        wrapper.failSilentOnce = false;
        throw new Error('simulated: no active session for silent authorization');
      }
      return inner.authorize(url, opts);
    },
  };
  return wrapper;
}
