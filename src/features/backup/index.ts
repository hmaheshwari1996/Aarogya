/**
 * The backup surface.
 *
 * `src/app/backup.tsx` calls `exportCapsule(profileId)` and `importCapsule(uri)` without a
 * passphrase, so both take theirs as an OPTIONAL second argument and fall back to the
 * recovery phrase this phone generated. See `./passphrase.ts` for why that is a recovery
 * code the user is meant to write down, and never a device-only secret.
 *
 * It also calls `listCapsules()`, `deleteCapsule(uri)`, `capsuleStampFromName(name)` and
 * `readBackupState()`. The screen used to keep private copies of the first two; they
 * drifted (its `listCapsules` dropped the modification time, its `backupDirectory` dropped
 * `idempotent`), which is the argument for it importing these rather than re-deriving them.
 *
 * Everything else here exists for the screens that come after: the "days since last copy"
 * figure, the typed restore failure the UI has to be able to explain, and the recovery
 * phrase itself.
 */

export {
  deleteCapsule,
  exportCapsule,
  listCapsules,
  type CapsuleDeleteOutcome,
  type CapsuleExportResult,
  type ExportOptions,
  type ExportProgress,
} from './capsule';

export {
  importCapsule,
  isRestoreError,
  RestoreError,
  RESTORE_FAILURE_COPY,
  type ImportOptions,
  type RestoreFailureReason,
  type RestoreProgress,
  type RestoreResult,
} from './restore';

export {
  daysBetweenEpochs,
  daysSinceLastCapsule,
  evaluateNudge,
  getBackupNudge,
  readBackupState,
  recordCapsuleWritten,
  recordCopyTakenOffDevice,
  recordNudgeShown,
  MIN_REPROMPT_DAYS,
  NUDGE_COPY,
  NUDGE_INTERVAL_DAYS,
  OVERDUE_DAYS,
  type BackupNudge,
  type BackupState,
  type NudgeLevel,
} from './nudge';

export {
  ensureRecoveryPhrase,
  formatPhrase,
  generateRecoveryPhrase,
  getStoredRecoveryPhrase,
  isWellFormedPhrase,
  normalisePhrase,
  replaceRecoveryPhrase,
  GROUP_COUNT,
  GROUP_SIZE,
  PHRASE_LENGTH,
} from './passphrase';

export {
  capsuleFileName,
  capsuleStampFromName,
  type CapsuleStamp,
  CAPSULE_EXTENSION,
  CHUNK_BYTES,
  FORMAT_VERSION,
  MAGIC,
  MAX_CAPSULE_BYTES,
  MAX_MEDIA_FILE_BYTES,
  type CapsuleEntry,
  type CapsuleHeader,
  type CapsuleManifest,
  type SkippedFile,
} from './format';

export { KDF_PARAMS, type KdfParams } from './crypto';

export {
  backupDirectory,
  scanMediaFiles,
  BACKUP_DIR_NAME,
  DB_CAPSULE_PATH,
  MEDIA_PREFIX,
  type MediaScan,
} from './paths';
