/**
 * Local Expo module: the native alarm layer.
 *
 *   import MedAlarm from '../../modules/med-alarm';
 *
 * Android only. Every export is safe to call on any platform and in Expo Go — see the
 * availability guard in ./src/MedAlarm.
 */
export { MedAlarm, default } from './src/MedAlarm';
export type {
  JournalEntry,
  MedAlarmChannelState,
  MedAlarmHealth,
  ReconcileResult,
} from './src/MedAlarm';
