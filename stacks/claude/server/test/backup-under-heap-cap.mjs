/**
 * Run `backUpBeforeMigration23` against a corpus deliberately larger than this
 * process's heap, and print the name of the file it wrote.
 *
 * This is spawned by `migration-23-record-stamp.test.ts` under an explicit
 * `--max-old-space-size`, because that cap is the assertion: the implementation
 * that read the whole `request` table with `.all()` and mapped it to strings
 * cannot finish here, and a streaming one barely notices. Running it in a child
 * is what makes the cap possible at all — Vitest's own worker sets the heap for
 * the whole suite, and a bound this test can dictate is the only bound worth
 * asserting.
 *
 * Plain `.mjs` rather than TypeScript so it starts with no loader, no transform
 * and no type-stripping cost — the memory number should be this function's, not
 * a toolchain's.
 *
 * argv: <logDir> <rowCount> <skimChars>
 */
import fs from 'node:fs';
import path from 'node:path';
import sqlite from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [logDir, rowCountRaw, skimCharsRaw] = process.argv.slice(2);
const rowCount = Number(rowCountRaw);
const skimChars = Number(skimCharsRaw);

const { backUpBeforeMigration23, BACKUP_DIR } = await import(
  pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db', 'open.ts')).href
);

const dbPath = path.join(logDir, 'claude-proxy.db');
const db = new sqlite.DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE request (
    id            TEXT PRIMARY KEY,
    body_derived  INTEGER NOT NULL DEFAULT 0,
    skim_text     TEXT
  );
  PRAGMA user_version = 22;
`);

// Built one row at a time and never retained, so seeding the fixture cannot be
// what exhausts the cap the assertion is about.
const insert = db.prepare('INSERT INTO request (id, body_derived, skim_text) VALUES (?, 1, ?)');
db.exec('BEGIN');
for (let index = 0; index < rowCount; index += 1) {
  insert.run(`req-${String(index).padStart(6, '0')}`, `${index}`.padEnd(skimChars, 'x'));
}
db.exec('COMMIT');

backUpBeforeMigration23(db, logDir);
db.close();

const files = fs.readdirSync(path.join(logDir, BACKUP_DIR));
process.stdout.write(`${files.join('\n')}\n`);
