#!/usr/bin/env node
/**
 * The receive-only guarantee, enforced.
 *
 * `src/features/sync/pushReceive.ts` is the ONE file allowed to import
 * expo-notifications (see eslint.config.js). It exists so a phone that is NOT the
 * profile owner's can be TOLD a dose is due. It must never SCHEDULE anything: the
 * local scheduler is modules/med-alarm, and a second scheduler means a dose fires
 * twice or not at all — the exact failure the project-wide ban exists to prevent.
 *
 * ESLint can stop the import elsewhere; it cannot stop THIS file from calling a
 * scheduling API. This does. A lint exemption without this check is a promise; with
 * it, it is a constraint.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'features', 'sync', 'pushReceive.ts');

/** Every expo-notifications API that puts a future notification on this device. */
const SCHEDULING_APIS = [
  'scheduleNotificationAsync',
  'setNotificationChannelAsync',
  'cancelScheduledNotificationAsync',
  'cancelAllScheduledNotificationsAsync',
  'getAllScheduledNotificationsAsync',
  'DailyTriggerInput',
  'CalendarTriggerInput',
  'TimeIntervalTriggerInput',
  'SchedulableTriggerInputTypes',
];

if (!fs.existsSync(FILE)) {
  // Not built yet. Nothing to guard, and this must not fail a build that predates it.
  console.log('no local scheduling\n  ✓ pushReceive.ts not present yet — nothing to check');
  process.exit(0);
}

const source = fs.readFileSync(FILE, 'utf8');
// Strip comments so the rationale above (which names these APIs) cannot trip the check.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const found = SCHEDULING_APIS.filter((api) => new RegExp(`\\b${api}\\b`).test(code));

if (found.length > 0) {
  console.error('no local scheduling');
  console.error(`  ✗ src/features/sync/pushReceive.ts calls a SCHEDULING API: ${found.join(', ')}`);
  console.error('');
  console.error('  This file may RECEIVE pushes. It may not schedule. Dose reminders are');
  console.error('  scheduled by modules/med-alarm alone — a second scheduler means a dose');
  console.error('  fires twice or not at all. Move the scheduling into med-alarm.');
  process.exit(1);
}

console.log('no local scheduling');
console.log('  ✓ pushReceive.ts receives only — no scheduling API is called');
