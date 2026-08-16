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
