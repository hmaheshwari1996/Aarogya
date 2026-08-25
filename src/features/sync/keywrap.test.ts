/**
 * Tests for the anonymous X25519 sealed-box.
 *
 * These prove the MATH on one process: a blob wrapped to a device's public key opens with that
 * device's secret key and nothing else, a flipped byte is rejected, and a wrap of the wrong
 * length is refused as a profile key. What they CANNOT prove — that device A can wrap to device
 * B's real published pubkey and B can unwrap — is device-gated (contract §7); this is the
 * one-process half of that guarantee.
 *
 * On the dynamic import + `.ts` resolve hook: see `sync.test.ts` in this directory.
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { x25519 } = await import('@noble/curves/ed25519.js');
// Non-literal specifier so the type-stripping loader gets the extension while tsc does
// not reject it — same trick as deviceHorizon.test.ts / migrations.test.ts.
const KEYWRAP_MODULE = './keywrap.ts';
const { sealAnon, openAnon, wrapProfileKey, unwrapProfileKey, PUBLIC_KEY_BYTES } = (await import(
  KEYWRAP_MODULE
)) as typeof import('./keywrap');
const SEALED_MODULE = './sealed.ts';
const { SHARE_KEY_BYTES } = (await import(SEALED_MODULE)) as typeof import('./sealed');

/** Deterministic nonce source. The ephemeral keypair still comes from the real CSPRNG. */
function fakeRandom(seed: number): (count: number) => Uint8Array {
  let state = seed >>> 0;
  return (count) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

function keypair() {
  const secret = x25519.utils.randomSecretKey();
  return { secret, pub: x25519.getPublicKey(secret) };
}

test('a sealed blob opens with the recipient secret and returns the exact plaintext', () => {
  const bob = keypair();
  const message = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const blob = sealAnon(bob.pub, message, fakeRandom(1));
  assert.deepEqual(Array.from(openAnon(bob.secret, blob) ?? []), Array.from(message));
});

test('the wrong recipient key returns null, not someone else’s plaintext', () => {
  const bob = keypair();
  const eve = keypair();
  const blob = sealAnon(bob.pub, new Uint8Array([1, 2, 3, 4]), fakeRandom(2));
  assert.equal(openAnon(eve.secret, blob), null);
});

test('a flipped byte anywhere in the blob returns null', () => {
  const bob = keypair();
  const blob = sealAnon(bob.pub, new Uint8Array(48).fill(7), fakeRandom(3));
  for (const i of [0, PUBLIC_KEY_BYTES, blob.length - 1]) {
    const tampered = Uint8Array.from(blob);
    tampered[i] = (tampered[i]! ^ 0xff) & 0xff;
    assert.equal(openAnon(bob.secret, tampered), null, `byte ${i}`);
  }
});

test('a truncated blob returns null rather than throwing', () => {
  const bob = keypair();
  const blob = sealAnon(bob.pub, new Uint8Array([1, 2, 3]), fakeRandom(4));
  assert.equal(openAnon(bob.secret, blob.subarray(0, 10)), null);
  assert.equal(openAnon(bob.secret, new Uint8Array(0)), null);
});

test('the profile-key round trip preserves all 32 bytes', () => {
  const bob = keypair();
  const key = fakeRandom(5)(SHARE_KEY_BYTES);
  const wrap = wrapProfileKey(key, bob.pub, fakeRandom(6));
  assert.deepEqual(Array.from(unwrapProfileKey(wrap, bob.secret) ?? []), Array.from(key));
});

test('unwrap refuses a blob that decrypts to the wrong length', () => {
  // A wrap of a label (not a key) must never be installed as a profile key.
  const bob = keypair();
  const notAKey = sealAnon(bob.pub, new Uint8Array([1, 2, 3]), fakeRandom(7));
  assert.equal(unwrapProfileKey(notAKey, bob.secret), null);
});

test('wrapProfileKey refuses a key that is not 32 bytes', () => {
  const bob = keypair();
  assert.throws(() => wrapProfileKey(new Uint8Array(16), bob.pub, fakeRandom(8)));
});

/** Strip `/* *​/` and `//` comments so a scan sees only live code, not prose ABOUT the hazard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('deviceKey mints its secret from expo-crypto, never the noble helper that throws on Hermes', () => {
  // Regression guard (finding: x25519.utils.randomSecretKey() calls @noble randomBytes, which
  // throws "crypto.getRandomValues must be defined" on Hermes/RN 0.81 — no global crypto — taking
  // the whole invite/join/key-release flow down on-device). The device keypair must draw its
  // 32-byte secret from expo-crypto like every other mint in this feature. Node tests pass either
  // way (Node HAS global crypto), so only a source scan catches a relapse.
  const src = stripComments(readFileSync(fileURLToPath(new URL('./deviceKey.ts', import.meta.url).href), 'utf8'));
  assert.equal(/randomSecretKey/.test(src), false, 'deviceKey.ts must not call x25519.utils.randomSecretKey() in live code');
  assert.equal(/Crypto\.getRandomBytes\(/.test(src), true, 'deviceKey.ts must source its secret from expo-crypto');
});
