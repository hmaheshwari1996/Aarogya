/**
 * Writing an accepted calendar to `care_event`. The only file here that touches the
 * database.
 *
 * It is separate from `calendar.ts` for two reasons. The first is testability: the
 * derivation is pure and exhaustively unit-tested, and it stays that way because it has
 * no SQLite underneath it. The second is that this file can then be read on its own as
 * the answer to one question — what, exactly, gets written when the user taps Confirm.
 *
 * ORDERING IS LOAD-BEARING. Anchors are written first, and their real row ids are what
 * the inferred rows hang off. `deriveInferredCareEvent()` refuses to create a row without
 * an anchor id, which is what makes "this date came from that date, plus a number we
 * chose" a fact in the database rather than a comment in the code.
 *
 * EVERY ROW WRITTEN HERE HAS BEEN ACCEPTED BY A PERSON. `validateProposedCalendar()` runs
 * first, the confirm screen shows transcribed and inferred separately, and only what the
 * user ticked arrives here. Nothing in this file may be called with unreviewed proposals.
 */

import { daysBetween } from '../../lib/datetime';
import {
  confirmCareEvent,
  createCareEvent,
  deriveInferredCareEvent,
  supersedeCareEvent,
  updateCareEvent,
} from '../../db/repositories/care';
import { inTransaction, queryAll, type Tx } from '../../db/repositories/_shared';
import type { CareEventKind } from '../../types';
import type { ProposedCareEvent } from './calendar';
import type { ProposedRefill } from './refill';

/** A proposal the user accepted, with any date she corrected. */
export type AcceptedCareRow = {
  readonly key: string;
  readonly kind: CareEventKind;
  readonly title: string;
  /** Possibly edited on the confirm screen. */
  readonly dueOn: string;
  readonly anchorSource: 'transcribed' | 'inferred';
  readonly anchorKey: string | null;
  readonly relatedTestKey: string | null;
};

export type WriteCalendarInput = {
  readonly profileId: string;
  readonly prescriptionId: string;
  readonly accepted: readonly AcceptedCareRow[];
  /**
   * Marks still-pending rows from EARLIER prescriptions as superseded. Defaults to true:
   * a new prescription's review date replaces the old one's, and leaving both pending
   * produces two appointments a fortnight apart with no way to tell which is current.
   */
  readonly supersedePrevious?: boolean;
};

export type WrittenRow = { readonly key: string; readonly id: string; readonly dueOn: string };

export type WriteCalendarResult = {
  readonly written: readonly WrittenRow[];
  readonly skipped: readonly { key: string; reason: string }[];
  readonly supersededIds: readonly string[];
};

/** Turn accepted proposals into rows. One transaction, anchors first. */
export async function writeConfirmedCalendar(
  input: WriteCalendarInput,
  tx?: Tx,
): Promise<WriteCalendarResult> {
  const written: WrittenRow[] = [];
  const skipped: { key: string; reason: string }[] = [];
  let supersededIds: string[] = [];

  await inTransaction(async (t) => {
    if (input.supersedePrevious !== false) {
      supersededIds = await supersedePreviousPrescriptionEvents(
        input.profileId,
        input.prescriptionId,
        t,
      );
    }

    const idByKey = new Map<string, string>();
    const dueByKey = new Map<string, string>();

    // Transcribed first, unconditionally: an inferred row cannot exist before the row it
    // is anchored to, and the accepted list is not guaranteed to arrive in order.
    const ordered = [
      ...input.accepted.filter((row) => row.anchorSource === 'transcribed'),
      ...input.accepted.filter((row) => row.anchorSource === 'inferred'),
    ];

    for (const row of ordered) {
      if (row.anchorSource === 'transcribed') {
        const id = await createCareEvent(
          {
            profileId: input.profileId,
            kind: row.kind,
            title: row.title,
            dueOn: row.dueOn,
            anchorSource: 'transcribed',
            prescriptionId: input.prescriptionId,
            relatedTestKey: row.relatedTestKey ?? null,
          },
          t,
        );
        // A transcribed row is a machine's reading of handwriting and starts unconfirmed;
        // it is confirmed here because it has just been through the confirm screen.
        await confirmCareEvent(id, t);
        idByKey.set(row.key, id);
        dueByKey.set(row.key, row.dueOn);
        written.push({ key: row.key, id, dueOn: row.dueOn });
        continue;
      }

      const anchorKey = row.anchorKey;
      const anchorId = anchorKey ? idByKey.get(anchorKey) : undefined;
      const anchorDue = anchorKey ? dueByKey.get(anchorKey) : undefined;
      if (!anchorKey || !anchorId || !anchorDue) {
        // The user unticked the visit but left a "book the test" row behind it. Writing
        // it anyway would create an app-derived date with nothing to explain it.
        skipped.push({ key: row.key, reason: 'its anchor was not accepted' });
        continue;
      }

      // Recomputed from the FINAL dates, so that a date the user dragged still satisfies
      // due_on = anchor + offset. `recomputeInferredDueDate()` relies on that pair later.
      const offsetDays = daysBetween(anchorDue, row.dueOn);
      const id = await deriveInferredCareEvent(
        {
          profileId: input.profileId,
          kind: row.kind,
          title: row.title,
          anchorEventId: anchorId,
          anchorDueOn: anchorDue,
          offsetDays,
          prescriptionId: input.prescriptionId,
          relatedTestKey: row.relatedTestKey ?? null,
        },
        t,
      );
      await confirmCareEvent(id, t);
      idByKey.set(row.key, id);
      dueByKey.set(row.key, row.dueOn);
      written.push({ key: row.key, id, dueOn: row.dueOn });
    }
  }, tx);

  return { written, skipped, supersededIds };
}

/**
 * A refill row, written after the user has seen the arithmetic.
 *
 * `anchorSource: 'manual'` — and the reason is in `refill.ts`: a refill hangs off no other
 * calendar entry, so it cannot be an 'inferred' row in the sense this schema means (one
 * that names an anchor and moves when the anchor moves). Its inputs are the quantity she
 * counted and the schedule she confirmed; the app contributes a division and a lead time,
 * both shown on screen at the moment she accepts them. `offset_days` records that lead
 * time so the row can still explain itself.
 */
export async function writeConfirmedRefill(
  input: {
    readonly profileId: string;
    readonly proposal: ProposedRefill;
    readonly prescriptionId?: string | null;
  },
  tx?: Tx,
): Promise<string> {
  return inTransaction(async (t) => {
    const id = await createCareEvent(
      {
        profileId: input.profileId,
        kind: 'refill',
        title: input.proposal.title,
        dueOn: input.proposal.dueOn,
        anchorSource: 'manual',
        prescriptionId: input.prescriptionId ?? null,
        relatedThreadId: input.proposal.relatedThreadId,
      },
      t,
    );
    // createCareEvent always stores offset_days = 0; the lead time is patched in so the
    // row records how many days early the reminder was set.
    await updateCareEvent(id, { offsetDays: input.proposal.offsetDays }, t);
    return id;
  }, tx);
}

/**
 * A test the doctor advised with no date on the paper: the user picks the day.
 *
 * Her date is 'manual' — she typed it, nobody read it off anything. The book/collect rows
 * that hang off it are ordinary inferred rows with the usual offsets, so the chain looks
 * and behaves exactly like the one derived from a written follow-up.
 */
export async function writeUserDatedTest(
  input: {
    readonly profileId: string;
    readonly prescriptionId: string;
    readonly testName: string;
    readonly relatedTestKey: string;
    /** The day she chose for the test itself. */
    readonly testDoOn: string;
    readonly chain: readonly ProposedCareEvent[];
  },
  tx?: Tx,
): Promise<WriteCalendarResult> {
  const written: WrittenRow[] = [];
  const skipped: { key: string; reason: string }[] = [];

  await inTransaction(async (t) => {
    const anchorId = await createCareEvent(
      {
        profileId: input.profileId,
        kind: 'test_do',
        title: `Get the ${input.testName} done`,
        dueOn: input.testDoOn,
        anchorSource: 'manual',
        prescriptionId: input.prescriptionId,
        relatedTestKey: input.relatedTestKey,
      },
      t,
    );
    written.push({ key: `${input.relatedTestKey}:do`, id: anchorId, dueOn: input.testDoOn });

    for (const row of input.chain) {
      if (row.kind === 'test_do') continue; // the anchor above
      if (row.anchorSource !== 'inferred') {
        skipped.push({ key: row.key, reason: 'only inferred rows may hang off a typed date' });
        continue;
      }
      const offsetDays = daysBetween(input.testDoOn, row.dueOn);
      const id = await deriveInferredCareEvent(
        {
          profileId: input.profileId,
          kind: row.kind,
          title: row.title,
          anchorEventId: anchorId,
          anchorDueOn: input.testDoOn,
          offsetDays,
          prescriptionId: input.prescriptionId,
          relatedTestKey: input.relatedTestKey,
        },
        t,
      );
      await confirmCareEvent(id, t);
      written.push({ key: row.key, id, dueOn: row.dueOn });
    }
  }, tx);

  return { written, skipped, supersededIds: [] };
}

/**
 * Retires still-pending rows that came from an EARLIER prescription.
 *
 * Scoped deliberately: only rows carrying a different `prescription_id`, and only the
 * kinds this pipeline creates. A refill she set up herself, a manually typed appointment,
 * and anything with no prescription behind it are all left alone — superseding those
 * would be the app deleting her own entries because a new photograph arrived.
 */
async function supersedePreviousPrescriptionEvents(
  profileId: string,
  prescriptionId: string,
  tx: Tx,
): Promise<string[]> {
  const rows = await queryAll<{ id: string }>(
    `SELECT id FROM care_event
      WHERE profile_id = ?
        AND deleted_at_epoch IS NULL
        AND status = 'pending'
        AND prescription_id IS NOT NULL
        AND prescription_id <> ?
        AND kind IN ('visit','book_appointment','test_book','test_do','test_collect');`,
    [profileId, prescriptionId],
    tx,
  );
  for (const row of rows) await supersedeCareEvent(row.id, tx);
  return rows.map((row) => row.id);
}
