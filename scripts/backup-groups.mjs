import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function sqlite() { return createRequire(import.meta.url)('node:sqlite').DatabaseSync; }
function privatePath(path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('GROUP_DB_PATH and backup paths must be absolute');
  let parent = path;
  while (parent !== dirname(parent)) {
    if (!['/tmp', '/var'].includes(parent) && lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Refusing symlinked database or backup path');
    parent = dirname(parent);
  }
  if (existsSync(path)) {
    if (process.getuid && lstatSync(path).uid !== process.getuid()) throw new Error('Database or backup must belong to current user');
    chmodSync(path, directory ? 0o700 : 0o600);
  }
}
function integrity(path) {
  const DatabaseSync = sqlite(); const db = new DatabaseSync(path, { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed'); }
  finally { db.close(); }
}
const suffix = () => `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;

/** VACUUM INTO includes all committed WAL pages, without copying a live file. */
export async function backupGroups(path, destination = join(dirname(path), 'backups')) {
  privatePath(path); privatePath(destination, true);
  if (!existsSync(path)) throw new Error('Database does not exist');
  mkdirSync(destination, { recursive: true, mode: 0o700 }); privatePath(destination, true);
  const output = join(destination, `groups-${suffix()}.sqlite.bak`);
  const DatabaseSync = sqlite(); const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('VACUUM INTO ?').run(output); }
  finally { db.close(); if (existsSync(output)) chmodSync(output, 0o600); }
  integrity(output); return output;
}

/** Operator must stop the sole server first. Preserve the old database for rollback. */
export async function restoreGroups(backup, target, serviceStopped = false) {
  if (!serviceStopped) throw new Error('Restore requires --service-stopped after stopping PM2');
  privatePath(backup); privatePath(target); privatePath(dirname(target), true);
  if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) throw new Error('Refusing restore while WAL/SHM exists; stop the service cleanly first');
  integrity(backup);
  const staged = `${target}.restore-${suffix()}`;
  copyFileSync(backup, staged); chmodSync(staged, 0o600); integrity(staged);
  const retained = `${target}.before-restore-${suffix()}.bak`;
  if (existsSync(target)) renameSync(target, retained);
  try { renameSync(staged, target); } catch (error) { if (existsSync(retained)) renameSync(retained, target); throw error; }
  return existsSync(retained) ? retained : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const action = args[0] === '--restore'
    ? restoreGroups(args[1], args[2] ?? process.env.GROUP_DB_PATH, args[3] === '--service-stopped')
    : backupGroups(args[0] ?? process.env.GROUP_DB_PATH, args[1]);
  action.then(path => console.log(path ?? 'Restore completed')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
