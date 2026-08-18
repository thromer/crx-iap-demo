// Mirrors packages/iap-auth/src/hash.ts's shortHash() exactly (same algorithm, same 8-char
// SHA-256 prefix) so a request log entry's recorded Authorization header value is directly
// comparable to IapClient's own tokenId — e.g. against `currentTokenId(driver, origin)` in the
// e2e suite — without ever recording the raw token (checkpoint-3 review, Task 13). Duplicated
// rather than imported: this package has no dependency on iap-auth, and the two are small
// enough that keeping them in sync by inspection is cheaper than adding one for this alone.
export async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 8);
}

// Returns the hashed tokenId for a raw `Authorization` header value, or undefined if it isn't
// a well-formed `Bearer <token>` header (absent, wrong scheme, etc.).
export async function bearerTokenId(authHeader: string | undefined): Promise<string | undefined> {
  if (authHeader === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(authHeader);
  const token = match?.[1];
  if (!token) return undefined;
  return shortHash(token);
}
