import type { KeyValueStore } from '@iap-demo/iap-auth';

// Access tokens live in chrome.storage.session: it is wiped on browser restart, matching an
// access token's short natural lifetime and never touching disk. Refresh tokens and client
// registrations live in chrome.storage.local: they must survive a restart (test 12) or the
// user would be forced through interactive re-authorization every time Chrome reopens, which
// is exactly the spurious-prompt behavior this project exists to eliminate. The tradeoff is
// that a refresh token sits on disk in the profile directory — acceptable here because Chrome
// profile storage is already the trust boundary for cookies and other extensions' credentials.
function chromeStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    async get(key) {
      const result = await area.get(key);
      return result[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async delete(key) {
      await area.remove(key);
    },
  };
}

export function createSessionStore(): KeyValueStore {
  return chromeStore(chrome.storage.session);
}

export function createDurableStore(): KeyValueStore {
  return chromeStore(chrome.storage.local);
}
