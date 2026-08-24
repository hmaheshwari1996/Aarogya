/**
 * The archive branching, proved without a database. See ./profileArchive.ts for why the
 * decision is pure: the two failures below are the ones tsc cannot see.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Non-literal './x.ts' specifier: the type-stripping loader needs the extension, while tsc
// (no allowImportingTsExtensions) would reject a literal one. Same trick as migrations.test.ts.
const MODULE = './profileArchive.ts';
const { planProfileArchive } = (await import(MODULE)) as typeof import('./profileArchive');

test('an unknown or already-archived id is a no-op, never a throw', () => {
  assert.deepEqual(planProfileArchive(null, []), { archive: false, promoteToDefaultId: null });
  assert.deepEqual(planProfileArchive(null, ['a', 'b']), { archive: false, promoteToDefaultId: null });
});

test('the last live patient may not be archived — that would strand the app on no profile', () => {
  assert.throws(() => planProfileArchive({ isDefault: false }, []), /only patient/);
  assert.throws(() => planProfileArchive({ isDefault: true }, []), /only patient/);
});

test('archiving a NON-default profile promotes nobody', () => {
  assert.deepEqual(planProfileArchive({ isDefault: false }, ['b', 'c']), {
    archive: true,
    promoteToDefaultId: null,
  });
});

test('archiving the default promotes the oldest remaining profile, so exactly one default survives', () => {
  // liveOtherIdsOldestFirst is ordered by created_at_epoch ASC by the caller, so [0] is the heir.
  assert.deepEqual(planProfileArchive({ isDefault: true }, ['b', 'c']), {
    archive: true,
    promoteToDefaultId: 'b',
  });
});
