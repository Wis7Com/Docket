import * as fs from "fs";
import * as path from "path";
import { getDb } from "./sqlite";
import type Database from "better-sqlite3";

export function runMigrationsForDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationsDir = path.resolve(__dirname, "..", "..", "migrations");
  const allSqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"));
  const files = allSqlFiles
    .filter((f) => f.endsWith("_sqlite_schema.sql") || f.match(/^\d+_.+\.sqlite\.sql$/))
    .sort();
  const unrecognized = allSqlFiles.filter((f) => !files.includes(f));
  if (unrecognized.length > 0) {
    // A misnamed migration silently never running is worse than failing the
    // boot: surface it immediately.
    throw new Error(
      `Unrecognized migration file(s) in ${migrationsDir}: ${unrecognized.join(", ")}. ` +
        "SQLite migrations must be named <NNN>_<name>.sqlite.sql.",
    );
  }

  const applied = new Set(
    db
      .prepare("SELECT filename FROM schema_migrations")
      .all()
      .map((r) => (r as { filename: string }).filename),
  );

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return;

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const txn = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(
        file,
      );
    });
    txn();
    console.log(`[migrate] applied ${file}`);
  }
}

export function runMigrations(): void {
  runMigrationsForDb(getDb());
}
