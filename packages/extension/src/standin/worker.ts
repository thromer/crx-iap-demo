// Stands in for the real third-party library's bundled worker: partly WASM, partly
// transpiled TS, not modified by us, doing its own fetch patching exactly like the snippet in
// PROMPT.md. This is what proves declarativeNetRequest reaches Worker-issued requests
// regardless of the JS execution context or patch layer between the command and the wire.

const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  // A real library might log, retry, or transform the response here. The stand-in does
  // nothing of substance — it only needs to prove the patch layer doesn't matter to DNR.
  return realFetch(input, init);
};

interface StandInCommand {
  id: number;
  url: string;
  method?: string;
}

type StandInReply = { id: number; status: number } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<StandInCommand>) => {
  const { id, url, method } = event.data;
  try {
    const response = await self.fetch(url, { method: method ?? 'GET' });
    const reply: StandInReply = { id, status: response.status };
    self.postMessage(reply);
  } catch (err) {
    const reply: StandInReply = { id, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(reply);
  }
};
