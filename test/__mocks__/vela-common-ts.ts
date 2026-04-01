/**
 * Stub for @horizen/vela-common-ts in tests.
 * The real library is a browser-only ESM bundle that can't run in Node.js.
 * Tests use MockTeeAuthenticator which accepts any payload, so real ECIES is not needed.
 */
export async function encrypt(
  _privateKey: unknown,
  _publicKey: unknown,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  // Fake ECIES: 133-byte ephemeral key + 12-byte nonce + plaintext + 16-byte tag
  const fakeEphemeralKey = new Uint8Array(133).fill(0x04);
  const result = new Uint8Array(133 + 12 + plaintext.length + 16);
  result.set(fakeEphemeralKey, 0);
  result.set(plaintext, 133 + 12);
  return result;
}

export async function decrypt(
  _privateKey: unknown,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  // Reverse of mock encrypt: skip 133 + 12 header, strip 16-byte tag
  return ciphertext.slice(133 + 12, ciphertext.length - 16);
}
