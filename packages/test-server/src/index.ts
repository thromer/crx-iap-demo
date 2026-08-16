import type http from 'node:http';
import type https from 'node:https';
import { createAuthorizationServer, createTokenValidator } from './as.ts';
import { generateCertificates } from './certs/generate.ts';
import { ORIGINS, PORTS } from './config.ts';
import { createControlServer } from './control.ts';
import { createResourceServer } from './rs.ts';
import { state } from './state.ts';

export interface TestServerHandle {
  origins: typeof ORIGINS;
  caCertPem: string;
  leafSpkiSha256Base64: string;
  close(): Promise<void>;
}

function listen(server: http.Server | https.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, resolve));
}

function close(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startTestServer(): Promise<TestServerHandle> {
  state.reset();
  const cert = generateCertificates();

  const { provider, server: asServer } = createAuthorizationServer(cert);
  const tokenValidator = createTokenValidator(provider);
  const rsAServer = createResourceServer('rs-a', ORIGINS.rsA, cert, tokenValidator, ORIGINS.as);
  const rsBServer = createResourceServer('rs-b', ORIGINS.rsB, cert, tokenValidator, ORIGINS.as);
  const controlServer = createControlServer();

  await Promise.all([
    listen(asServer, PORTS.as),
    listen(rsAServer, PORTS.rsA),
    listen(rsBServer, PORTS.rsB),
    listen(controlServer, PORTS.control),
  ]);

  return {
    origins: ORIGINS,
    caCertPem: cert.caCertPem,
    leafSpkiSha256Base64: cert.leafSpkiSha256Base64,
    async close() {
      await Promise.all([
        close(asServer),
        close(rsAServer),
        close(rsBServer),
        close(controlServer),
      ]);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = await startTestServer();
  console.log('test-server listening:');
  console.log(`  authorization server: ${handle.origins.as}`);
  console.log(`  resource server A:    ${handle.origins.rsA}`);
  console.log(`  resource server B:    ${handle.origins.rsB}`);
  console.log(`  control plane:        ${handle.origins.control}`);
  console.log(`  leaf SPKI (base64):   ${handle.leafSpkiSha256Base64}`);
}
