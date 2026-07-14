import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDescendantDocIds,
  evidenceDocumentIds,
} from "./folderDocScope";

test("collectDescendantDocIds includes the folder subtree only", () => {
  const folders = [
    { id: "root", parent_folder_id: null },
    { id: "child", parent_folder_id: "root" },
    { id: "sibling", parent_folder_id: null },
  ];
  const documents = [
    { id: "a", folder_id: "root" },
    { id: "b", folder_id: "child" },
    { id: "c", folder_id: "sibling" },
    { id: "d", folder_id: null },
  ];
  assert.deepEqual(
    collectDescendantDocIds(folders, documents, "root").sort(),
    ["a", "b"],
  );
});

test("evidenceDocumentIds excludes briefs and unclassified documents", () => {
  assert.deepEqual(
    evidenceDocumentIds([
      { id: "brief", doc_role: "brief" },
      { id: "evidence", doc_role: "evidence" },
      { id: "other" },
    ]),
    ["evidence"],
  );
});
