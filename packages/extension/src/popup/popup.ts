import type { ActionOutcome, FetchOutcome, SwRequest } from '../shared/messages.ts';

const LAST_URL_KEY = 'popup:lastUrl';

const urlInput = document.getElementById('url') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLPreElement;
const fetchButton = document.getElementById('fetch') as HTMLButtonElement;
const loginButton = document.getElementById('login') as HTMLButtonElement;
const logoutButton = document.getElementById('logout') as HTMLButtonElement;

async function restoreLastUrl(): Promise<void> {
  const stored = await chrome.storage.local.get(LAST_URL_KEY);
  const last = stored[LAST_URL_KEY];
  if (typeof last === 'string') urlInput.value = last;
}

function persistUrl(): void {
  void chrome.storage.local.set({ [LAST_URL_KEY]: urlInput.value });
}

function send<T>(message: SwRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function render(outcome: FetchOutcome | ActionOutcome, extra: Record<string, unknown> = {}): void {
  statusEl.textContent = JSON.stringify({ ...outcome, ...extra }, null, 2);
}

fetchButton.addEventListener('click', async () => {
  persistUrl();
  const url = urlInput.value;
  statusEl.textContent = 'Fetching…';
  const outcome = await send<FetchOutcome>({ type: 'fetch', resource: url });
  render(outcome);
});

loginButton.addEventListener('click', async () => {
  persistUrl();
  const resource = originOf(urlInput.value);
  statusEl.textContent = 'Logging in…';
  const outcome = await send<ActionOutcome>({
    type: 'login',
    resource,
    opts: { interactive: true },
  });
  render(outcome, { resource });
});

logoutButton.addEventListener('click', async () => {
  persistUrl();
  const resource = originOf(urlInput.value);
  statusEl.textContent = 'Logging out…';
  const outcome = await send<ActionOutcome>({ type: 'logout', resource });
  render(outcome, { resource });
});

void restoreLastUrl();
