import assert from "node:assert/strict";
import test from "node:test";
import type Database from "better-sqlite3";
import {
  DB_OPEN_RETRY,
  openDatabaseWithRetry,
  PROJECT_DB_OPEN_RETRY,
} from "./sqlite";

function fakeDb(): Database.Database {
  return {
    pragma: () => undefined,
    close: () => undefined,
  } as unknown as Database.Database;
}

test("project databases do not synchronously retry on request paths", () => {
  assert.deepEqual(PROJECT_DB_OPEN_RETRY, { attempts: 1, delayMs: 0 });
  assert.ok(PROJECT_DB_OPEN_RETRY.attempts < DB_OPEN_RETRY.attempts);
});

test("openDatabaseWithRetry retries transient SQLITE_CANTOPEN failures", () => {
  let attempts = 0;
  const db = fakeDb();

  const opened = openDatabaseWithRetry(
    "/tmp/docket.db",
    () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("unable to open database file"), {
          code: "SQLITE_CANTOPEN",
        });
      }
      return db;
    },
    { attempts: 5, delayMs: 0 },
  );

  assert.equal(opened, db);
  assert.equal(attempts, 3);
});

test("openDatabaseWithRetry does not retry non-open SQLite failures", () => {
  let attempts = 0;
  const err = Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
  });

  assert.throws(
    () =>
      openDatabaseWithRetry(
        "/tmp/docket.db",
        () => {
          attempts += 1;
          throw err;
        },
        { attempts: 5, delayMs: 0 },
      ),
    err,
  );
  assert.equal(attempts, 1);
});
