import forge from 'node-forge';

export interface GeneratedCertificates {
  caCertPem: string;
  leafCertPem: string;
  leafKeyPem: string;
  /** base64 SHA-256 of the leaf cert's SubjectPublicKeyInfo, for --ignore-certificate-errors-spki-list */
  leafSpkiSha256Base64: string;
}

function makeSerial(): string {
  // forge wants a hex string with no leading zero-that-looks-like-a-sign-bit
  return `01${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
}

/**
 * Generates a fresh CA + leaf certificate pair covering localhost/127.0.0.1, valid for
 * the lifetime of a single test run. Nothing is written to disk or committed: regenerating
 * per-run keeps there from ever being a private key fixture to leak.
 */
export function generateCertificates(): GeneratedCertificates {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = makeSerial();
  caCert.validity.notBefore = new Date(Date.now() - 60_000);
  caCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: 'commonName', value: 'iap-demo test CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = makeSerial();
  leafCert.validity.notBefore = new Date(Date.now() - 60_000);
  leafCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const leafAttrs = [{ name: 'commonName', value: 'localhost' }];
  leafCert.setSubject(leafAttrs);
  leafCert.setIssuer(caAttrs);
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const spkiDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(leafKeys.publicKey)).getBytes();
  const spkiSha256 = forge.md.sha256.create().update(spkiDer).digest().getBytes();
  const leafSpkiSha256Base64 = forge.util.encode64(spkiSha256);

  return {
    caCertPem: forge.pki.certificateToPem(caCert),
    leafCertPem: forge.pki.certificateToPem(leafCert),
    leafKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    leafSpkiSha256Base64,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { leafSpkiSha256Base64 } = generateCertificates();
  console.log('Leaf SPKI SHA-256 (base64):', leafSpkiSha256Base64);
}
