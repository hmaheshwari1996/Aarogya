/**
 * The family-sharing surface.
 *
 * `src/app/settings/viewers.tsx` is the patient's side and `src/app/(viewer)/` is the
 * family member's; between them they use `getShareLink`, `ensureShareLink`,
 * `rotateShareLink`, `shareableText`, `acceptViewerLink` and `fetchSharedSnapshot`. Those
 * are the contract; everything else here exists for the background passes.
 *
 * THE THREE RULES THIS FEATURE IS BUILT ON, in case only this file is ever read:
 *
 *  1. The server holds ciphertext and nothing else. `./sealed.ts` and `./crypto.ts`.
 *  2. THE LINK IS THE CREDENTIAL, and the key rides in its fragment, which no HTTP request
 *     ever carries. Whoever holds the whole link can read the record; rotating replaces
 *     both halves and deletes the old dataset. `./link.ts` and `./share.ts`.
 *  3. Every background path no-ops silently when sharing is not configured, because L1 and
 *     L2 ship long before any of this. `./config.ts`.
 */

export {
  acceptViewerLink,
  assetLinksJson,
  ensureShareLink,
  forgetViewerLink,
  getShareLink,
  getViewerLink,
  rotateShareLink,
  shareLinkCode,
  shareLinkUrl,
  shareableText,
  REVOKE_DISCLOSURE,
  SyncNotConfiguredError,
  type RotateResult,
  type ShareLink,
} from './share';

export {
  isShareHostConfigured,
  parseShareLink,
  SHARE_PATH_PREFIX,
  type ShareLinkParts,
} from './link';

export {
  fetchSharedSnapshot,
  publishSnapshot,
  type FetchOutcome,
  type PublishOutcome,
  type SharedAlert,
  type SharedDose,
  type SharedLab,
  type SharedMedicine,
  type SharedReading,
  type SharedSnapshot,
} from './snapshot';

export {
  drainOutbox,
  drainOutboxFully,
  outboxDepth,
  republishRecords,
  BATCH_SIZE,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  type DrainOutcome,
} from './outbox';

export {
  checkDoseSilence,
  composeWhatsAppMessage,
  evaluateSilence,
  recordQuietDoseAlert,
  whatsAppShareUrl,
  CONSECUTIVE_THRESHOLD,
  GRACE_MS,
  LOOKBACK_DAYS,
  MIN_ALERT_INTERVAL_MS,
  type AlertOutcome,
  type DoseSilence,
  type WhatsAppDraft,
} from './alerts';

export { forgetShareKey } from './crypto';

export {
  disableSync,
  getSyncConfig,
  isSyncConfigured,
  normaliseUrl,
  setSyncConfig,
  type SyncConfig,
  type SyncConfigPatch,
  type SyncRole,
} from './config';

export {
  clientFor,
  createClient,
  createPatientClient,
  eq,
  REMOTE_TABLES,
  REQUEST_TIMEOUT_MS,
  type RemoteRecord,
  type RemoteShare,
  type SyncClient,
  type SyncClientError,
  type SyncResponse,
} from './client';

export {
  bucketFor,
  openJson,
  openRecord,
  pad,
  recordAad,
  sealJson,
  sealRecord,
  snapshotAad,
  unpad,
  MAX_RECORD_BYTES,
  PAD_BUCKETS,
  SHARE_KEY_BYTES,
  type RandomSource,
} from './sealed';

export { syncOnAppOpen } from './appOpen';
