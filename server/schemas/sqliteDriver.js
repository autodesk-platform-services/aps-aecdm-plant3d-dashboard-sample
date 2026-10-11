const { execFileSync } = require('child_process');

/**
 * Reads rows from a SQLite file without adding a dependency.
 *
 * Drivers are tried in order and the first available one wins:
 *   1. node:sqlite      built in from Node 22.5 — nothing to install
 *   2. better-sqlite3   if the project happens to have it
 *   3. sqlite3 CLI      the system binary, which is what Node 20 falls back to
 *
 * Every driver opens the database read-only. A .dcf is a live Plant 3D project
 * file and must never be written to or left with a stale -journal beside it.
 */

/** node:sqlite — present from Node 22.5. */
function nodeSqlite(dbPath, sql) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null; // older Node, or the flag is off
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** better-sqlite3 — only if it is already installed. */
function betterSqlite3(dbPath, sql) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return null;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/**
 * The system sqlite3 binary. `-json` needs 3.33+; SQL goes in over stdin so it
 * is never subject to shell quoting or argument length limits.
 */
function sqliteCli(dbPath, sql) {
  let stdout;
  try {
    stdout = execFileSync('sqlite3', ['-readonly', '-json', dbPath], {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') return null; // no sqlite3 on PATH
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`sqlite3 failed: ${detail}`);
  }
  // A query returning no rows prints nothing at all.
  return stdout.trim() ? JSON.parse(stdout) : [];
}

const DRIVERS = [
  ['node:sqlite', nodeSqlite],
  ['better-sqlite3', betterSqlite3],
  ['sqlite3 CLI', sqliteCli],
];

/** Runs `sql` against `dbPath`, returning an array of plain row objects. */
function query(dbPath, sql) {
  for (const [name, driver] of DRIVERS) {
    const rows = driver(dbPath, sql);
    if (rows !== null) {
      query.lastDriver = name;
      return rows;
    }
  }
  throw new Error(
    'No SQLite driver available. Use Node 22.5+, run `npm i better-sqlite3`, ' +
      'or install the sqlite3 command-line tool.',
  );
}

/** Which driver the last query used — handy in logs and tests. */
query.lastDriver = null;

module.exports = { query };
