// Session (volatile) keys — access tokens only.
export function accessKey(resource: string): string {
  return `access:${resource}`;
}

// Durable keys — survive restart.
export function refreshKey(resource: string): string {
  return `refresh:${resource}`;
}

export function resourceMetadataKey(resource: string): string {
  return `rsmeta:${resource}`;
}

export function asMetadataKey(issuer: string): string {
  return `asmeta:${issuer}`;
}

export function clientRegistrationKey(issuer: string): string {
  return `client:${issuer}`;
}
