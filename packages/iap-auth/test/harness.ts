import { Agent, setGlobalDispatcher } from 'undici';
import { startTestServer, type TestServerHandle } from '../../test-server/src/index.ts';

export async function withTestServer<T>(fn: (handle: TestServerHandle) => Promise<T>): Promise<T> {
  const handle = await startTestServer();
  setGlobalDispatcher(new Agent({ connect: { ca: handle.caCertPem } }));
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

export async function armScenario(
  controlOrigin: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${controlOrigin}/control/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...args }),
  });
  if (!res.ok) throw new Error(`arm scenario "${name}" failed: ${res.status}`);
}

export async function resetServer(controlOrigin: string): Promise<void> {
  const res = await fetch(`${controlOrigin}/control/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
}

export interface RequestLogEntry {
  seq: number;
  timestamp: number;
  server: 'as' | 'rs-a' | 'rs-b';
  method: string;
  origin: string;
  path: string;
  hadAuthorizationHeader: boolean;
}

export async function getRequestLog(controlOrigin: string): Promise<RequestLogEntry[]> {
  const res = await fetch(`${controlOrigin}/control/requests`);
  return (await res.json()) as RequestLogEntry[];
}

export async function countRequests(
  controlOrigin: string,
  predicate: (entry: RequestLogEntry) => boolean,
): Promise<number> {
  const log = await getRequestLog(controlOrigin);
  return log.filter(predicate).length;
}
