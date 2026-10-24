/* Verifies lib/sealedBox.ts against real libsodium.
 *
 * GitHub decrypts with libsodium, so the only useful test is: does libsodium
 * accept what we produced? Run with `node tools/verify-sealedbox.mjs`.
 *
 * libsodium-wrappers is a devDependency and is only used here — the Pages
 * Function deliberately does not import it, because its wasm cannot run in the
 * Workers runtime.
 */
import sodium from 'libsodium-wrappers';
import { sealBox, fromBase64, toBase64 } from '../lib/sealedBox.ts';

await sodium.ready;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const { publicKey, privateKey } = sodium.crypto_box_keypair();

console.log('nonce derivation');

/* The nonce is the part most likely to be got silently wrong: BLAKE2b-192 is
   a different digest from BLAKE2b-512 truncated. */
{
  const input = new Uint8Array(64).map((_, i) => i);
  const libsodiumNonce = sodium.crypto_generichash(24, input);
  const { blake2b } = await import('@noble/hashes/blake2.js');
  const noble = blake2b(input, { dkLen: 24 });
  check('BLAKE2b-192 matches crypto_generichash(24)', Buffer.compare(Buffer.from(noble), Buffer.from(libsodiumNonce)) === 0);

  const truncated = blake2b(input, { dkLen: 64 }).slice(0, 24);
  check(
    'BLAKE2b-192 is not BLAKE2b-512 truncated (guards the trap)',
    Buffer.compare(Buffer.from(truncated), Buffer.from(libsodiumNonce)) !== 0,
  );
}

console.log('shared key');

/* crypto_box_beforenm = X25519 then HSalsa20. tweetnacl's box.before must
   agree, or the ciphertext will not decrypt. */
{
  const a = sodium.crypto_box_keypair();
  const b = sodium.crypto_box_keypair();
  const nacl = (await import('tweetnacl')).default;
  const ours = nacl.box.before(b.publicKey, a.privateKey);
  const theirs = sodium.crypto_box_beforenm(b.publicKey, a.privateKey);
  check('box.before matches crypto_box_beforenm', Buffer.compare(Buffer.from(ours), Buffer.from(theirs)) === 0);
}

console.log('end to end — libsodium opens what we seal');

for (const [label, message] of [
  ['32 random bytes', sodium.randombytes_buf(32)],
  ['empty message', new Uint8Array(0)],
  ['utf-8 text', new TextEncoder().encode('Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc')],
  ['100 KB cookies.txt', sodium.randombytes_buf(100 * 1024)],
]) {
  const sealed = sealBox(message, publicKey);
  const opened = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
  check(`opens ${label}`, opened !== null && Buffer.compare(Buffer.from(opened), Buffer.from(message)) === 0);
  check(`format ${label} is epk(32) + ciphertext(16 + len)`, sealed.length === 32 + 16 + message.length);
}

console.log('key handling');
{
  let threw = '';
  try {
    sealBox(new Uint8Array(4), new Uint8Array(31));
  } catch (e) {
    threw = e.message;
  }
  check('rejects a short public key', /must be 32 bytes/.test(threw), threw);

  check('base64 round-trips', Buffer.compare(
    Buffer.from(fromBase64(toBase64(new Uint8Array([0, 1, 254, 255, 128])))),
    Buffer.from([0, 1, 254, 255, 128]),
  ) === 0);
}

/* Every seal must use a fresh ephemeral key, or the same plaintext would
   produce the same ciphertext and leak equality. */
{
  const message = new TextEncoder().encode('same');
  const one = sealBox(message, publicKey);
  const two = sealBox(message, publicKey);
  check('uses a fresh ephemeral key per call', Buffer.compare(Buffer.from(one.subarray(0, 32)), Buffer.from(two)) !== 0);
}

console.log(failures === 0 ? '\nAll sealed-box checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
