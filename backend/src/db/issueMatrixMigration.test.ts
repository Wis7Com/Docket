import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMigrationsForDb } from "./migrate";
import { getDbForPath, runWithDatabaseContext } from "./sqlite";
import { createServerSupabase } from "../lib/supabase";

test("issue matrix migration creates constrained tables and JSON round-trips", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docket-issue-matrix-"));
  const dbPath = path.join(root, "project.db");
  await runWithDatabaseContext(
    { kind: "project", dbPath, dataRoot: root, projectId: "project-1" },
    async () => {
      const db = getDbForPath(dbPath);
      db.pragma("foreign_keys = ON");
      runMigrationsForDb(db);
      runMigrationsForDb(db);

      const tableNames = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('issue_matrices','issue_matrix_cells') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        tableNames.map((row) => row.name),
        ["issue_matrices", "issue_matrix_cells"],
      );
      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_issue_matrix_cells_matrix'",
        )
        .get() as { name?: string } | undefined;
      assert.equal(index?.name, "idx_issue_matrix_cells_matrix");

      db.prepare(
        "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
      ).run("project-1", "user-1", "Matter");
      const client = createServerSupabase();
      const issues = [{ index: 0, title: "Jurisdiction", summary: "Forum" }];
      const scope = {
        sides: [
          { label: "A", doc_ids: ["doc-a"] },
          { label: "B", doc_ids: ["doc-b"] },
        ],
        excluded_doc_ids: [],
      };
      const { data: matrix, error } = await client
        .from("issue_matrices")
        .insert({
          id: "matrix-1",
          project_id: "project-1",
          user_id: "user-1",
          scope,
          issues,
        })
        .select("*")
        .single();
      assert.equal(error, null);
      assert.deepEqual(matrix?.issues, issues);
      assert.deepEqual(matrix?.scope, scope);

      await client.from("issue_matrix_cells").insert({
        id: "cell-1",
        matrix_id: "matrix-1",
        issue_index: 0,
        side_label: "A",
        citations: [{ chunk_id: "chunk-1" }],
      });
      const duplicate = await client.from("issue_matrix_cells").insert({
        id: "cell-2",
        matrix_id: "matrix-1",
        issue_index: 0,
        side_label: "A",
        citations: [],
      });
      assert.match(duplicate.error?.message ?? "", /UNIQUE constraint failed/);
      const { data: cells } = await client
        .from("issue_matrix_cells")
        .select("citations")
        .eq("id", "cell-1");
      assert.deepEqual(cells?.[0]?.citations, [{ chunk_id: "chunk-1" }]);
    },
  );
});
