import * as oauth from 'oauth4webapi';

export type Challenge =
  | { kind: 'none' }
  | { kind: 'bearer'; resourceMetadataUrl: string | undefined }
  | { kind: 'other' };

export interface OptimisticResult {
  response: Response;
  challenge: Challenge;
}

/**
 * Issues the caller's request to a protected resource, attaching `token` as a Bearer
 * credential when present. When `token` is undefined, the request carries no Authorization
 * header at all — this is the "optimistic, no pre-probe" path.
 *
 * Always goes through oauth4webapi's `protectedResourceRequest`, which unconditionally sends
 * `redirect: 'manual'` — so an Authorization header is never replayed to a redirect target —
 * and parses `WWW-Authenticate` itself. When there is no real token, `customFetch` is used to
 * strip the placeholder Authorization header back off before the request leaves the process;
 * oauth4webapi requires a non-empty token argument to reach its challenge parser at all, but
 * this project's standing rule is to never hand-parse WWW-Authenticate (quoted strings and
 * multiple challenges are easy to get subtly wrong), so this is the seam that lets us reuse
 * the library's parser for the token-less path too.
 */
export async function issueResourceRequest(
  method: string,
  url: URL,
  headers: Headers,
  body: oauth.ProtectedResourceRequestBody,
  token: string | undefined,
): Promise<OptimisticResult> {
  const options = token
    ? undefined
    : {
        [oauth.customFetch]: async (
          input: string,
          init: oauth.CustomFetchOptions<string, oauth.ProtectedResourceRequestBody>,
        ) => {
          const strippedHeaders = new Headers(init.headers);
          strippedHeaders.delete('authorization');
          return fetch(input, {
            ...init,
            headers: strippedHeaders,
            body: (init.body ?? null) as BodyInit | null,
          });
        },
      };

  try {
    const response = await oauth.protectedResourceRequest(
      token ?? 'unused-no-token-sent',
      method,
      url,
      headers,
      body,
      options,
    );
    return { response, challenge: { kind: 'none' } };
  } catch (err) {
    if (err instanceof oauth.WWWAuthenticateChallengeError) {
      const bearer = err.cause.find((c) => c.scheme === 'bearer');
      if (!bearer) return { response: err.response, challenge: { kind: 'other' } };
      return {
        response: err.response,
        challenge: { kind: 'bearer', resourceMetadataUrl: bearer.parameters.resource_metadata },
      };
    }
    throw err;
  }
}
