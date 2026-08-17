import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Structural guarantee for Task 1's chokepoint, not a convention: every network call this
// module makes must be classified as TRANSPORT on failure in exactly one place
// (net.ts's transportFetch/transportCustomFetch). A bare `fetch(` call anywhere else in
// packages/iap-auth/src is exactly how two call sites got silently missed before (see the
// checkpoint-3 review's A.4/B.6 findings) — this test fails the moment a third one appears,
// rather than relying on remembering to route it through the chokepoint by hand.
//
// packages/typescript in this repo is v7 (the Go-based rewrite); its package entry point no
// longer exposes the classic createSourceFile/compiler AST, so this is a text-based check
// rather than a real parse. To avoid false positives from that, string/template literal
// contents are stripped first (catches client.ts's ReadableStream error message, which
// mentions "fetch()" in prose) and matches at the start of a line are excluded (catches
// `async fetch(input, init) {` in client.ts and the `fetch(...)` method signature in
// types.ts — both are declarations of a member named `fetch`, not calls to the global
// function, and in this codebase's style a real call is never the first token on its line —
// it's always preceded by `await`, `return`, `=`, etc.).

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The only file allowed to call the real global `fetch` — everything else must go through the
// functions it exports.
const ALLOWED_FILE = 'net.ts';

function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function findBareFetchCalls(source: string): string[] {
  const cleaned = stripStringsAndComments(source);
  return cleaned
    .split('\n')
    .map((line, i) => ({ line, lineNumber: i + 1 }))
    .filter(({ line }) => /(?<![.\w])fetch\(/.test(line) && !/^\s*(async\s+)?fetch\(/.test(line))
    .map(({ line, lineNumber }) => `${lineNumber}: ${line.trim()}`);
}

describe('no bare fetch() outside net.ts', () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));

  it('scanned at least the source files expected (sanity check the scan itself runs)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    if (file === ALLOWED_FILE) continue;
    it(`${file} does not call the global fetch() directly`, () => {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      expect(findBareFetchCalls(source)).toEqual([]);
    });
  }

  it(`${ALLOWED_FILE} calls the global fetch() exactly once (transportFetch's chokepoint)`, () => {
    const source = readFileSync(join(SRC_DIR, ALLOWED_FILE), 'utf8');
    expect(findBareFetchCalls(source)).toHaveLength(1);
  });
});
