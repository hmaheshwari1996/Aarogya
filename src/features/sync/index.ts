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
 *
 * v2 (family sharing) adds a fourth, which supersedes the single-writer assumption above for
 * the `sync_row` stream ONLY: every MEMBER device writes one profile, merged by
 * last-write-wins on a millisecond modified-time (`./merge`, `./rowStream`). The legacy
 * `sync_record`/`sync_share` single-viewer path is unchanged.
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
  publishSharedProfiles,
  republishRecords,
  BATCH_SIZE,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  type DrainOutcome,
  type SharedPublishOutcome,
} from './outbox';

// ── v2 family sharing ────────────────────────────────────────────────────────

export {
  canWriteNow,
  isReminderTable,
  mergeStrategyFor,
  normaliseRole,
  roleCapabilities,
  rowIsNewer,
  type MergeStrategy,
  type RoleCapabilities,
  type RowStamp,
} from './merge';

export {
  approve,
  changeRole,
  deny,
  getShareView,
  listPendingRequests,
  mintInvite,
  postJoinRequest,
  removeMember,
  type Invite,
  type JoinRequestOutcome,
  type JoinRequestView,
  type MemberView,
  type PendingRequest,
  type ShareView,
} from './membership';

export { acknowledgeOwnership, applyOwnerRow, changeOwner, type OwnerRow } from './owner';

export {
  gatherPushTargets,
  publishDeviceToken,
  sendFamilyPing,
  type FamilyPing,
  type PingResult,
  type PushTarget,
} from './push';

export {
  applyPulledRow,
  buildRowUpsert,
  pullAndApplyShare,
  pullRows,
  sealRowPayload,
  type ApplyContext,
  type ApplyOutcome,
  type PulledRow,
} from './rowStream';

export {
  forgetDeviceKeyPair,
  getDevicePublicKeyB64,
  getOrCreateDeviceKeyPair,
  type DeviceKeyPair,
} from './deviceKey';

export { forgetProfileKey, getProfileKey, type ProfileKeyState } from './profileKey';

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

export { syncOnAppOpen, syncNow } from './appOpen';
