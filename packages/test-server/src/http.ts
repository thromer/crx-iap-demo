import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { MalformedMetadataKind } from './state.ts';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export function sendMalformed(res: ServerResponse, kind: MalformedMetadataKind): void {
  if (kind === 'html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>not json</body></html>');
    return;
  }
  if (kind === 'truncated') {
    const full = JSON.stringify({
      resource: 'https://example.invalid',
      authorization_servers: ['https://example.invalid'],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(full.slice(0, Math.floor(full.length / 2)));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"resource":"https://example.invalid","padding":"');
  const chunk = 'a'.repeat(1024 * 1024);
  for (let i = 0; i < 10; i += 1) res.write(chunk);
  res.end('"}');
}

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Rebuilds a consumed IncomingMessage into a replayable one carrying the same headers,
 * so a buffered body can be peeked (to make a scenario decision) and then still handed
 * to oidc-provider's own request handler.
 */
export function replayableRequest(req: IncomingMessage, body: Buffer): IncomingMessage {
  const stream = Readable.from(body.length > 0 ? [body] : []);
  return Object.assign(stream, {
    headers: req.headers,
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    socket: req.socket,
    aborted: false,
  }) as unknown as IncomingMessage;
}

export function delay(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Captures the OAuth `error` field (RFC 6749 §5.2: `{error: "...", ...}`) from whatever this
 * response actually ends up sending, generically — whether it's this project's own scenario
 * handlers (`sendJson`) or oidc-provider's own native error responses (invalid_client,
 * invalid_grant from a PKCE failure, etc.), which are written directly by oidc-provider's
 * internal request handling, never through this project's own code. Calls `onError` once, only
 * if the response is JSON and parses with a string `.error` field (checkpoint-3 review, Task
 * 20 — "record the AS's OAuth error code alongside the existing fields," generically enough
 * that a future error this project didn't anticipate is still captured, not just the ones its
 * own scenario handlers emit).
 */
export function captureResponseErrorCode(
  res: ServerResponse,
  onError: (code: string) => void,
): void {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const contentType = res.getHeader('content-type');
    if (typeof contentType === 'string' && contentType.includes('application/json')) {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body) {
        try {
          const parsed: unknown = JSON.parse(body);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            typeof (parsed as { error: unknown }).error === 'string'
          ) {
            onError((parsed as { error: string }).error);
          }
        } catch {
          // Not JSON, or not this shape — nothing to capture.
        }
      }
    }
    return (originalEnd as (...args: unknown[]) => ServerResponse)(chunk, ...rest);
  }) as typeof res.end;
}
