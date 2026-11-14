// @vitest-environment node
import { createRequire } from 'node:module';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { backupGroups, restoreGroups } from '../scripts/backup-groups.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
it('backs up committed WAL pages uniquely and restores only offline after integrity verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'group-backup-')); const path = join(root, 'groups.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'kept\');');
    const first = await backupGroups(path, join(root, 'backups'));
    const second = await backupGroups(path, join(root, 'backups'));
    expect(first).not.toBe(second); expect(statSync(first).mode & 0o077).toBe(0);
    await expect(restoreGroups(first, path)).rejects.toThrow(/stopped/);
    await expect(restoreGroups(first, path, true)).rejects.toThrow(/WAL|SHM/);
    db.close();
    const retained = await restoreGroups(first, path, true);
    expect(statSync(retained).isFile()).toBe(true);
    const restored = new DatabaseSync(path); expect(restored.prepare('SELECT value FROM proof').get().value).toBe('kept'); restored.close();
  } finally { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});
