# Dev signing key

`dev-key.pem` is a throwaway RSA keypair used only to pin `manifest.json`'s `"key"` field, so
the extension ID (`heecdlemhfiphfndhfknejaalfmamlii`) — and therefore the DCR `redirect_uri` —
is stable across profiles and between unpacked and packed builds. It is **not** used to sign a
`.crx` for distribution; Chrome Web Store publishing uses its own signing infrastructure
regardless of this field.

To regenerate (changes the extension ID — update host-based assumptions like the registered
`redirect_uri` if you do):

```sh
openssl genrsa -out dev-key.pem 2048
openssl rsa -in dev-key.pem -pubout -outform DER | openssl base64 -A
# paste the output into manifest.json's "key" field
```
