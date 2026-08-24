/**
 * Contacts and documents — `contact` + `document`.
 *
 * Both tables carry `created_at_epoch`/`updated_at_epoch`/`deleted_at_epoch` but NO
 * `lamport` column (see TABLES in _shared.ts). The write helpers already account for
 * that; nothing here should mention lamport.
 *
 * `document.file_uri` points at a file in this app's own on-device storage. There is
 * no cloud copy of it, by design — the app has no server to lose her prescription
 * photos to.
 *
 * ─── WHO OWNS THE FILE ────────────────────────────────────────────────────────────
 *
 * This module used to say, flatly, that deleting a document row must NEVER delete the
 * underlying file. That rule was right for the only case that existed at the time and
 * wrong as a general one, and `owns_file` (migration v4) is the distinction it was
 * missing:
 *
 *   owns_file = 0 — the row INDEXES a file some other feature created and still refers
 *     to. A prescription photograph is the canonical case: `prescription.image_uri`
 *     points at it too, it is the only evidence of what the doctor actually wrote, and
 *     removing a listing must not touch it. This is the DEFAULT, so a caller that has
 *     not thought about ownership gets the safe behaviour.
 *
 *   owns_file = 1 — the app COPIED this file into its own storage for this row when she
 *     added it, and nothing else refers to it. Every briefcase document is this. Here the
 *     old rule inverts: leaving the bytes behind after she taps Remove means a copy of
 *     her discharge summary stays on the phone with nothing in the app able to find it,
 *     list it, or delete it again — which, in an app that promises everything stays here
 *     and goes when she says so, is a privacy failure rather than an untidiness.
 *
 * ─── THE FILESYSTEM RULE SURVIVES INTACT ──────────────────────────────────────────
 *
 * Nothing in this module touches the filesystem. `deleteDocument` writes a row to
 * `pending_file_delete` in the SAME transaction as the soft delete, and a sweeper outside
 * the database layer does the unlinking — see ./files.ts. That is strictly stronger than
 * unlinking here would have been: it is atomic with the delete, and it survives a crash
 * between the two.
 */

import {
  createRecord,
  inTransaction,
  boolToInt,
  intToBool,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';
import { requestFileDelete } from './files';

// ── Types ────────────────────────────────────────────────────────────────────

export type Contact = {
  id: string;
  profileId: string;
  label: string;
  role: string | null;
  phone: string | null;
  address: string | null;
  sortOrder: number;
};

/**
 * The categories the briefcase offers.
 *
 * `document.kind` is TEXT with no CHECK constraint and stays that way — a row written by
 * an older build, or by a feature that has its own idea of a category, must not become
 * unreadable. This list is what a picker shows and what the label map covers; anything
 * else falls back to a generic label rather than failing.
 *
 * 'prescription' and 'lab_report' predate the briefcase and are matched by the existing
 * documents screen. The rest are what an Indian household actually keeps in the folder
 * this feature is named after.
 */
export const DOCUMENT_KINDS = [
  'prescription',
  'lab_report',
  'discharge_summary',
  'scan_report',
  'insurance',
  'id_card',
  'bill',
  'other',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Named `DocumentRecord`, not `Document`, because the DOM lib's global `Document` is
 * in scope in this project and a same-named export makes every import site ambiguous
 * to read.
 */
export type DocumentRecord = {
  id: string;
  profileId: string;
  /** Free text by schema. `DOCUMENT_KINDS` is what the briefcase offers, not a constraint. */
  kind: string;
  /** What she can read at arm's length. Never a filename by default. */
  title: string;
  /** On-device URI. Whether it may be unlinked is `ownsFile`, never an assumption. */
  fileUri: string;
  /**
   * The name the file arrived with, kept ALONGSIDE the title rather than instead of it.
   * 'IMG_20260304_113522.jpg' tells this user nothing and the thumbnail tells her
   * everything — but 'AXIS-DISCHARGE-2024-11.pdf' is what makes the file recognisable to
   * whoever it gets sent on to. Null for a file that never had one.
   */
  originalFileName: string | null;
  /** So the share sheet hands the receiving app the right type. Null = never learned. */
  mimeType: string | null;
  sizeBytes: number | null;
  /** True only when the app copied this file in for this row. See the file header. */
  ownsFile: boolean;
  /**
   * Pinned to the top of the briefcase. A per-device VIEW preference — it does not travel
   * (document does not sync; see v5), because which papers one person keeps to hand is not a
   * fact about the health record.
   */
  isPinned: boolean;
  /** Powers "added on …" without a second query. */
  createdAtEpoch: number;
};

export type CreateContactInput = {
  profileId: string;
  label: string;
  role?: string | null;
  phone?: string | null;
  address?: string | null;
  sortOrder?: number;
};

export type ContactPatch = {
  label?: string;
  role?: string | null;
  phone?: string | null;
  address?: string | null;
  sortOrder?: number;
};

export type AddDocumentInput = {
  profileId: string;
  kind: string;
  title: string;
  /**
   * A URI in the app's OWN storage. The caller copies the picked file there first — an
   * `expo-image-picker` or `expo-document-picker` result lives in the cache directory,
   * which Android empties under storage pressure, and on a mid-range handset that is not
   * hypothetical. Storing the picker's URI produces a briefcase that quietly empties
   * itself. `persistPhoto` in src/app/labs/new.tsx is the copy step to follow.
   */
  fileUri: string;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  /**
   * TRUE only when this row is the sole owner of that file — i.e. the caller copied it in
   * for this row and nothing else refers to it. Every briefcase document is true. A row
   * that merely indexes a prescription photograph is false, which is the default.
   *
   * Getting this wrong in the true direction deletes evidence another feature still
   * needs; wrong in the false direction leaves bytes behind after she asked for them to
   * go. It defaults to the second, because that one is recoverable.
   */
  ownsFile?: boolean;
};

export type ListDocumentsOptions = {
  kind?: string;
};

type ContactRow = {
  id: string;
  profile_id: string;
  label: string;
  role: string | null;
  phone: string | null;
  address: string | null;
  sort_order: number;
};

type DocumentRow = {
  id: string;
  profile_id: string;
  kind: string;
  title: string;
  file_uri: string;
  original_file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  owns_file: number;
  is_pinned: number;
  created_at_epoch: number;
};

const CONTACT_COLUMNS = 'id, profile_id, label, role, phone, address, sort_order';
const DOCUMENT_COLUMNS = `id, profile_id, kind, title, file_uri, original_file_name,
     mime_type, size_bytes, owns_file, is_pinned, created_at_epoch`;

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    profileId: row.profile_id,
    label: row.label,
    role: row.role,
    phone: row.phone,
    address: row.address,
    sortOrder: row.sort_order,
  };
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    title: row.title,
    fileUri: row.file_uri,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    ownsFile: intToBool(row.owns_file),
    isPinned: intToBool(row.is_pinned),
    createdAtEpoch: row.created_at_epoch,
  };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/**
 * Ordered by `sort_order`, then creation time.
 *
 * The tiebreaker is not cosmetic: every contact is created with the schema default of
 * 100, so until someone reorders the list EVERY row ties and SQLite is free to return
 * them in whatever order it likes — which would mean the emergency contact list
 * reshuffles itself between screens.
 */
export async function listContacts(profileId: string, tx?: Tx): Promise<Contact[]> {
  const rows = await queryAll<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contact
      WHERE profile_id = ? AND deleted_at_epoch IS NULL
      ORDER BY sort_order ASC, created_at_epoch ASC;`,
    [profileId],
    tx,
  );
  return rows.map(mapContact);
}

export async function getContact(id: string, tx?: Tx): Promise<Contact | null> {
  const row = await queryFirst<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contact
      WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapContact(row) : null;
}

export async function createContact(input: CreateContactInput, tx?: Tx): Promise<string> {
  const values: Record<string, Bind> = {
    profile_id: input.profileId,
    label: input.label,
    role: input.role ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
  };
  // Left to the schema default (100) when unset, which lands new contacts after
  // anything the user has explicitly ordered — appending, not jumping the queue.
  if (input.sortOrder !== undefined) values['sort_order'] = input.sortOrder;
  return createRecord('contact', values, tx);
}

export async function updateContact(id: string, patch: ContactPatch, tx?: Tx): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.label !== undefined) values['label'] = patch.label;
  if (patch.role !== undefined) values['role'] = patch.role;
  if (patch.phone !== undefined) values['phone'] = patch.phone;
  if (patch.address !== undefined) values['address'] = patch.address;
  if (patch.sortOrder !== undefined) values['sort_order'] = patch.sortOrder;
  if (Object.keys(values).length === 0) return;
  await updateRecord('contact', id, values, tx);
}

export async function deleteContact(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('contact', id, tx);
}

/**
 * Rewrites the whole ordering in one transaction.
 *
 * All-or-nothing because a partially applied reorder leaves duplicate `sort_order`
 * values, and the list then renders in an order matching neither the old one nor the
 * new one — the user drags a contact and watches the list scramble.
 *
 * Ids are verified to belong to `profileId` first. `updateRecord` addresses rows by
 * primary key alone, so an id from another profile would otherwise be silently
 * writable through this call; the throw aborts the transaction and nothing lands.
 */
export async function reorderContacts(
  profileId: string,
  orderedIds: readonly string[],
  tx?: Tx,
): Promise<void> {
  if (orderedIds.length === 0) return;
  await inTransaction(async (t) => {
    const rows = await queryAll<{ id: string }>(
      `SELECT id FROM contact WHERE profile_id = ? AND deleted_at_epoch IS NULL;`,
      [profileId],
      t,
    );
    const owned = new Set(rows.map((row) => row.id));
    for (const id of orderedIds) {
      if (!owned.has(id)) {
        throw new Error(`reorderContacts: contact ${id} does not belong to profile ${profileId}`);
      }
    }
    for (const [index, id] of orderedIds.entries()) {
      await updateRecord('contact', id, { sort_order: index }, t);
    }
  }, tx);
}

// ── Documents ────────────────────────────────────────────────────────────────

export async function listDocuments(
  profileId: string,
  options: ListDocumentsOptions = {},
  tx?: Tx,
): Promise<DocumentRecord[]> {
  const where = ['profile_id = ?', 'deleted_at_epoch IS NULL'];
  const params: Bind[] = [profileId];
  if (options.kind !== undefined) {
    where.push('kind = ?');
    params.push(options.kind);
  }

  const rows = await queryAll<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM document
      WHERE ${where.join(' AND ')}
      ORDER BY created_at_epoch DESC;`,
    params,
    tx,
  );
  return rows.map(mapDocument);
}

export async function getDocument(id: string, tx?: Tx): Promise<DocumentRecord | null> {
  const row = await queryFirst<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM document
      WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapDocument(row) : null;
}

/**
 * Every path a LIVE document row points at, across every profile.
 *
 * ─── WHAT THIS IS FOR, AND WHY IT DELIBERATELY IGNORES PROFILES ──────────────
 * The orphan sweep in `src/features/files/sweeper.ts` asks the opposite question from the
 * rest of this module: not "what documents does she have" but "is there anything on disk
 * that no row knows about". The answer decides whether bytes get unlinked, so the query
 * has to be TOTAL. A profile filter here would make every other profile's discharge
 * summary look unreferenced, and the sweep would delete it.
 *
 * Soft-deleted rows are excluded on purpose. A file whose only row is deleted is already
 * queued in `pending_file_delete` by `deleteDocument`, and `requestFileDelete` deduplicates
 * on the path — so the worst the sweep can do with one is ask for a deletion that was
 * already asked for.
 *
 * `owns_file` is not consulted either. The sweep only ever looks inside the briefcase
 * directory, which the app wrote every byte of; a row that merely INDEXES a file elsewhere
 * still protects it here, which is the safe direction.
 */
export async function listDocumentFileUris(tx?: Tx): Promise<string[]> {
  const rows = await queryAll<{ file_uri: string }>(
    `SELECT file_uri FROM document
      WHERE deleted_at_epoch IS NULL AND file_uri IS NOT NULL AND file_uri <> '';`,
    [],
    tx,
  );
  return rows.map((row) => row.file_uri);
}

/**
 * Indexes an already-saved file. The caller owns copying it into app storage first —
 * see `AddDocumentInput.fileUri`, which is where the trap is described.
 *
 * The title is required and is trimmed, not defaulted from the filename: a briefcase
 * whose rows all read 'Scan_0032.pdf' is a briefcase she cannot use. A screen that wants
 * to suggest the filename should suggest it into the field she can edit.
 */
export async function addDocument(input: AddDocumentInput, tx?: Tx): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error('addDocument: title is required');
  const fileUri = input.fileUri.trim();
  if (!fileUri) throw new Error('addDocument: fileUri is required');
  if (input.sizeBytes !== undefined && input.sizeBytes !== null && input.sizeBytes < 0) {
    throw new Error('addDocument: sizeBytes cannot be negative');
  }

  return createRecord(
    'document',
    {
      profile_id: input.profileId,
      kind: input.kind,
      title,
      file_uri: fileUri,
      original_file_name: input.originalFileName ?? null,
      mime_type: input.mimeType ?? null,
      size_bytes: input.sizeBytes ?? null,
      owns_file: boolToInt(input.ownsFile ?? false),
    },
    tx,
  );
}

/** Retitle or recategorise. The file itself is never re-pointed — add a new row for that. */
export async function updateDocument(
  id: string,
  patch: { title?: string; kind?: string },
  tx?: Tx,
): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('updateDocument: title cannot be blank');
    values['title'] = title;
  }
  if (patch.kind !== undefined) values['kind'] = patch.kind;
  if (Object.keys(values).length === 0) return;
  await updateRecord('document', id, values, tx);
}

/**
 * Pin or unpin a document. Purely a briefcase-ordering preference; it never touches the file
 * and, because `document` does not sync, it stays on this device (see the field comment).
 */
export async function setDocumentPinned(id: string, pinned: boolean, tx?: Tx): Promise<void> {
  await updateRecord('document', id, { is_pinned: boolToInt(pinned) }, tx);
}

/**
 * Removes the document, and — when the app owns the file — guarantees the bytes follow.
 *
 * ONE TRANSACTION, which is the whole design. Either the row is still listed and the file
 * is intact, or the row is delisted AND a durable deletion request exists on disk. There
 * is no third state where she has been told it is gone and it is not; a crash between the
 * two is impossible rather than unlikely.
 *
 * The unlink itself happens in the sweeper (see ./files.ts). This function does not touch
 * the filesystem, cannot fail on it, and cannot be defeated by an app that is killed one
 * millisecond later.
 *
 * TWO GUARDS BEFORE ANYTHING IS QUEUED:
 *
 *   1. `owns_file` must be 1. A row that merely indexes another feature's photograph
 *      leaves it exactly where it is — deleting the only copy of a prescription because
 *      someone tidied a list is unrecoverable.
 *   2. No OTHER live document row may point at the same path. Two rows sharing a file
 *      should not happen — the briefcase copies each pick to its own name — but "should
 *      not happen" is not a guarantee, and the failure mode is a photograph vanishing
 *      from a row nobody touched.
 *
 * Already-deleted or unknown ids are a no-op, so a double tap cannot queue twice.
 */
export async function deleteDocument(id: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const row = await queryFirst<{ file_uri: string; owns_file: number }>(
      `SELECT file_uri, owns_file FROM document WHERE id = ? AND deleted_at_epoch IS NULL;`,
      [id],
      t,
    );
    if (!row) return;

    await softDeleteRecord('document', id, t);

    if (!intToBool(row.owns_file)) return;

    const shared = await queryFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM document
        WHERE file_uri = ? AND id <> ? AND deleted_at_epoch IS NULL;`,
      [row.file_uri, id],
      t,
    );
    if ((shared?.n ?? 0) > 0) return;

    await requestFileDelete(row.file_uri, 'document', t);
  }, tx);
}
