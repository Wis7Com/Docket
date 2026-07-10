import test from "node:test";
import assert from "node:assert/strict";
import {
    mergeDirectoryResults,
    PROJECT_DIRECTORY_ERROR,
    resolveDirectoryListings,
} from "./directoryData";
import type { DocketDocument, DocketProject } from "./types";

function project(id: string, name = id): DocketProject {
    return {
        id,
        user_id: "user-1",
        name,
        cm_number: null,
        shared_with: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

function document(id: string, createdAt: string): DocketDocument {
    return {
        id,
        project_id: null,
        filename: `${id}.pdf`,
        file_type: "pdf",
        storage_path: null,
        pdf_storage_path: null,
        size_bytes: null,
        page_count: null,
        structure_tree: null,
        status: "ready",
        created_at: createdAt,
    };
}

test("mergeDirectoryResults replaces every summary when detail loading succeeds", () => {
    const summaries = [project("a"), project("b")];
    const fullProjects = [
        { status: "fulfilled", value: { ...summaries[0], name: "Full A" } },
        { status: "fulfilled", value: { ...summaries[1], name: "Full B" } },
    ] satisfies PromiseSettledResult<DocketProject>[];

    assert.deepEqual(
        mergeDirectoryResults(summaries, fullProjects).map((item) => item.name),
        ["Full A", "Full B"],
    );
});

test("mergeDirectoryResults preserves a summary when one detail request fails", () => {
    const summaries = [project("a", "Summary A"), project("b", "Summary B")];
    const fullProjects = [
        { status: "rejected", reason: new Error("legacy project") },
        { status: "fulfilled", value: { ...summaries[1], name: "Full B" } },
    ] satisfies PromiseSettledResult<DocketProject>[];

    assert.deepEqual(
        mergeDirectoryResults(summaries, fullProjects).map((item) => item.name),
        ["Summary A", "Full B"],
    );
});

test("standalone document failure does not discard project summaries", () => {
    const result = resolveDirectoryListings(
        { status: "fulfilled", value: [project("a")] },
        { status: "rejected", reason: new Error("documents unavailable") },
    );

    assert.deepEqual(result.projectSummaries.map((item) => item.id), ["a"]);
    assert.deepEqual(result.standaloneDocuments, []);
    assert.equal(result.error, null);
});

test("project list failure is exposed while standalone documents remain available", () => {
    const result = resolveDirectoryListings(
        { status: "rejected", reason: new Error("projects unavailable") },
        {
            status: "fulfilled",
            value: [
                document("older", "2026-01-01T00:00:00Z"),
                document("newer", "2026-02-01T00:00:00Z"),
            ],
        },
    );

    assert.deepEqual(result.projectSummaries, []);
    assert.deepEqual(
        result.standaloneDocuments.map((item) => item.id),
        ["newer", "older"],
    );
    assert.equal(result.error, PROJECT_DIRECTORY_ERROR);
});
