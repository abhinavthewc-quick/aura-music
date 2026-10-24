/* Sealed boxes, for handing a secret to GitHub's Actions secrets API.
 *
 * GitHub will not accept plaintext. It requires `encrypted_value` to be a
 * libsodium sealed box (crypto_box_seal) against the repository public key:
 *
 *     epk, esk   = X25519 keypair          (fresh for every call)
 *     nonce      = BLAKE2b(epk || pk, 24)  (variable-length digest, not truncated)
 *     ciphertext = XSalsa20-Poly1305(msg, nonce, X25519(esk, pk))
 *     sealed     = epk || ciphertext
 *
 * This used to be libsodium-wrappers, which is the obvious choice and is
 * correct everywhere else. It cannot work in a Pages Function: libsodium.js
 * is Emscripten and compiles its WebAssembly at runtime, and the Workers
 * runtime forbids that — it fails with "Wasm code generation disallowed by
 * embedder". The failure is not catchable into a fallback; it aborts the
 * module. So the primitives are assembled here from pure JavaScript instead:
 * tweetnacl for the NaCl box, @noble/hashes for BLAKE2b. Neither touches wasm.
 *
 * The nonce matters more than it looks: libsodium's crypto_generichash with a
 * 24-byte output is BLAKE2b-192 proper, which changes the digest's parameter
 * block, so it is not BLAKE2b-512 truncated to 24 bytes. Reaching for
 * `blake2b(msg).slice(0, 24)` here would produce a nonce GitHub cannot
 * reproduce, and every secret would fail to decrypt.
 *
 * tools/verify-sealedbox.mjs checks this against real libsodium, including
 * that a libsodium-generated key opens what we produce.
 */
import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2.js';

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 32;
const NONCE_BYTES = 24;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Encrypt `message` to `recipientPublicKey` in the sealed-box format. */
export function sealBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`recipient key must be ${PUBLIC_KEY_BYTES} bytes, got ${recipientPublicKey.length}`);
  }

  // Generate the ephemeral keypair from our own entropy rather than letting
  // tweetnacl pick its random source at import time. In a Worker that resolves
  // to self.crypto either way, but doing it here keeps the crypto independent
  // of how the bundler rewrote tweetnacl's Node branch.
  const seed = new Uint8Array(SECRET_KEY_BYTES);
  crypto.getRandomValues(seed);
  const ephemeral = nacl.box.keyPair.fromSecretKey(seed);

  const nonce = blake2b(concat(ephemeral.publicKey, recipientPublicKey), { dkLen: NONCE_BYTES });
  const boxed = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  if (!boxed) throw new Error('sealed box failed'); // nacl.box returns null on a bad key

  return concat(ephemeral.publicKey, boxed);
}

export function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  // Chunked: a cookies.txt can be ~100 KB and String.fromCharCode(...bytes)
  // would blow the argument limit.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}
