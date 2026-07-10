import test from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_IDS, BUILT_IN_WORKFLOWS } from "./builtinWorkflows";

const EXPECTED_BUILTIN_WORKFLOW_IDS = [
    "builtin-cp-checklist",
    "builtin-issue-comparison",
    "builtin-coc-dd",
    "builtin-credit-summary",
    "builtin-commercial-agreement",
    "builtin-credit-agreement",
    "builtin-ediscovery",
    "builtin-supply-agreement",
    "builtin-spa",
    "builtin-nda",
    "builtin-commercial-lease",
    "builtin-lpa",
    "builtin-sha-summary",
    "builtin-shareholder-agreement",
    "builtin-employment-agreement",
];

test("frontend built-in workflows keep the upstream Mike catalog ids", () => {
    assert.deepEqual(
        BUILT_IN_WORKFLOWS.map((workflow) => workflow.id),
        EXPECTED_BUILTIN_WORKFLOW_IDS,
    );
    assert.equal(BUILT_IN_IDS.size, EXPECTED_BUILTIN_WORKFLOW_IDS.length);
    for (const id of EXPECTED_BUILTIN_WORKFLOW_IDS) {
        assert.equal(BUILT_IN_IDS.has(id), true, `${id} should be built in`);
    }
});

test("assistant and tabular built-in workflows remain executable", () => {
    const assistant = BUILT_IN_WORKFLOWS.filter(
        (workflow) => workflow.type === "assistant",
    );
    const tabular = BUILT_IN_WORKFLOWS.filter(
        (workflow) => workflow.type === "tabular",
    );

    assert.equal(assistant.length, 4);
    assert.equal(tabular.length, 11);

    for (const workflow of assistant) {
        assert.ok(workflow.prompt_md?.trim(), `${workflow.id} needs a prompt`);
        assert.equal(workflow.columns_config, null);
    }

    for (const workflow of tabular) {
        if (workflow.prompt_md !== null) {
            assert.ok(workflow.prompt_md.trim(), `${workflow.id} prompt is empty`);
        }
        assert.ok(
            workflow.columns_config && workflow.columns_config.length > 0,
            `${workflow.id} needs tabular columns`,
        );
        workflow.columns_config?.forEach((column, index) => {
            assert.equal(
                column.index,
                index,
                `${workflow.id} column indexes should be sequential`,
            );
            assert.ok(column.name.trim(), `${workflow.id} column needs a name`);
            assert.ok(
                column.prompt.trim(),
                `${workflow.id} column ${column.index} needs a prompt`,
            );
        });
    }
});
