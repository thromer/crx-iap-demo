// Logs must record token *identity*, never token *value*. An 8-character SHA-256 prefix
// suffices to tell "same token" from "different token" apart in a trace.
export async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 8);
}
