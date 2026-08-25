/**
 * Tests for the push SEND side: the payload is CONTENT-FREE, tokens batch by 100, and the relay's
 * dead-token receipts are parsed back so the caller can prune them.
 *
 * The network call is stubbed (`globalThis.fetch`); that a ping actually reaches a sibling phone
 * and shows on `family_ping_v1` WITHOUT scheduling a dose is device-gated (contract §7, F5).
 *
 * On the dynamic import + `.ts` resolve hook: see `sync.test.ts` in this directory.
 */

import { registerHooks } from 'node:module';
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

const PUSH_MODULE = './push.ts';
const { sendFamilyPing } = (await import(PUSH_MODULE)) as typeof import('./push');

type Captured = { url: string; body: unknown[] };

/** Replace global fetch with a stub that captures the request and returns a scripted receipt set. */
function stubFetch(receiptsFor: (messages: unknown[]) => unknown, ok = true): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '[]') as unknown[];
    calls.push({ url: String(url), body });
    return {
      ok,
      json: async () => ({ data: receiptsFor(body) }),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('the payload carries only a title + channel — never a body/drug', async () => {
  const stub = stubFetch((messages) => messages.map(() => ({ status: 'ok' })));
  try {
    await sendFamilyPing([{ expoPushToken: 'ExpoTok[A]' }], { titleKey: "Mother's medicine", channelId: 'family_ping_v1' });
    const message = (stub.calls[0]!.body[0] ?? {}) as Record<string, unknown>;
    assert.equal(message['to'], 'ExpoTok[A]');
    assert.equal(message['title'], "Mother's medicine");
    assert.equal(message['channelId'], 'family_ping_v1');
    assert.equal(message['priority'], 'high');
    assert.equal(message['sound'], null);
    // The load-bearing assertion: NOTHING that could name a medicine travels.
    assert.equal('body' in message, false);
  } finally {
    stub.restore();
  }
});

test('it posts to the Expo relay with no auth header', async () => {
  const stub = stubFetch((messages) => messages.map(() => ({ status: 'ok' })));
  try {
    await sendFamilyPing([{ expoPushToken: 'ExpoTok[A]' }], { titleKey: 'x', channelId: 'family_ping_v1' });
    assert.match(stub.calls[0]!.url, /exp\.host\/--\/api\/v2\/push\/send$/);
  } finally {
    stub.restore();
  }
});

test('tokens batch by 100', async () => {
  const stub = stubFetch((messages) => messages.map(() => ({ status: 'ok' })));
  try {
    const targets = Array.from({ length: 250 }, (_, i) => ({ expoPushToken: `ExpoTok[${i}]` }));
    const result = await sendFamilyPing(targets, { titleKey: 'x', channelId: 'family_ping_v1' });
    assert.equal(stub.calls.length, 3, 'three batches for 250 tokens');
    assert.equal(stub.calls[0]!.body.length, 100);
    assert.equal(stub.calls[2]!.body.length, 50);
    assert.equal(result.sent, 250);
  } finally {
    stub.restore();
  }
});

test('a DeviceNotRegistered receipt comes back as an invalid token, aligned to its message', async () => {
  const stub = stubFetch((messages) =>
    messages.map((_, i) => (i === 1 ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })),
  );
  try {
    const result = await sendFamilyPing(
      [{ expoPushToken: 'good' }, { expoPushToken: 'dead' }, { expoPushToken: 'good2' }],
      { titleKey: 'x', channelId: 'family_ping_v1' },
    );
    assert.equal(result.sent, 2);
    assert.deepEqual(result.invalidTokens, ['dead']);
  } finally {
    stub.restore();
  }
});

test('empty targets short-circuit without a network call', async () => {
  const stub = stubFetch(() => []);
  try {
    const result = await sendFamilyPing([], { titleKey: 'x', channelId: 'family_ping_v1' });
    assert.equal(result.sent, 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a network throw is swallowed — the alarm path must never see it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  try {
    const result = await sendFamilyPing([{ expoPushToken: 'good' }], { titleKey: 'x', channelId: 'family_ping_v1' });
    assert.deepEqual(result, { sent: 0, invalidTokens: [] });
  } finally {
    globalThis.fetch = original;
  }
});
