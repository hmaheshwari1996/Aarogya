/**
 * Pins the three sort orders the briefcase offers. The failure this catches is a comparator
 * that sorts by the storage KEY instead of the label a reader sees, or one that leaves ties
 * in undefined order — either of which reshuffles her papers with nothing in the diff.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DocumentRecord } from '@/db/repositories/contacts';

// See the note in `deriveStatus.test.ts`: node's type-stripping loader wants the `.ts`
// extension, tsconfig (no `allowImportingTsExtensions`) forbids it on a static import. A
// non-literal specifier plus a typeof cast satisfies both.
const MODULE = './sort.ts';
const { sortDocuments } = (await import(MODULE)) as typeof import('./sort');

function doc(over: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: 'id',
    profileId: 'p',
    kind: 'other',
    title: 'Untitled',
    fileUri: 'file://x',
    originalFileName: null,
    mimeType: null,
    sizeBytes: null,
    ownsFile: true,
    isPinned: false,
    createdAtEpoch: 0,
    ...over,
  };
}

const ids = (docs: DocumentRecord[]): string[] => docs.map((d) => d.id);

// Kind sort must follow the LABEL, not the key: 'z_kind' labels 'Apple', 'a_kind' labels
// 'Zebra', so a label sort puts z_kind first and a key sort would put it last.
const kindLabelOf = (kind: string): string =>
  kind === 'z_kind' ? 'Apple' : kind === 'a_kind' ? 'Zebra' : kind;

test('recent: newest createdAtEpoch first', () => {
  const docs = [
    doc({ id: 'old', createdAtEpoch: 100 }),
    doc({ id: 'new', createdAtEpoch: 300 }),
    doc({ id: 'mid', createdAtEpoch: 200 }),
  ];
  assert.deepEqual(ids(sortDocuments(docs, 'recent', kindLabelOf)), ['new', 'mid', 'old']);
});

test('name: alphabetical by title, newest breaks a tie', () => {
  const docs = [
    doc({ id: 'b', title: 'Bill' }),
    doc({ id: 'a', title: 'Apollo' }),
    doc({ id: 'dup-old', title: 'Apollo', createdAtEpoch: 1 }),
    doc({ id: 'dup-new', title: 'Apollo', createdAtEpoch: 9 }),
  ];
  assert.deepEqual(ids(sortDocuments(docs, 'name', kindLabelOf)), [
    'dup-new',
    'dup-old',
    'a',
    'b',
  ]);
});

test('kind: by the label the reader sees, not the storage key', () => {
  const docs = [
    doc({ id: 'zebra', kind: 'a_kind' }), // label 'Zebra'
    doc({ id: 'apple', kind: 'z_kind' }), // label 'Apple'
  ];
  assert.deepEqual(ids(sortDocuments(docs, 'kind', kindLabelOf)), ['apple', 'zebra']);
});

test('does not mutate the input array', () => {
  const docs = [doc({ id: 'a', createdAtEpoch: 1 }), doc({ id: 'b', createdAtEpoch: 2 })];
  const before = ids(docs);
  sortDocuments(docs, 'recent', kindLabelOf);
  assert.deepEqual(ids(docs), before);
});
