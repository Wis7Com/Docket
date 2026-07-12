const assert = require("node:assert/strict");
const test = require("node:test");

const { cleanPackage } = require("./stage-backend");

test("cleanPackage removes the root self-reference and development dependencies", () => {
  const source = {
    name: "docket-backend",
    dependencies: {
      "docket-desktop": "file:..",
      express: "^4.22.2",
    },
    devDependencies: { tsx: "^4.19.3" },
  };

  const result = cleanPackage(source);

  assert.equal(result.strippedSelfReference, true);
  assert.deepEqual(result.manifest, {
    name: "docket-backend",
    dependencies: { express: "^4.22.2" },
  });
  assert.equal(source.dependencies["docket-desktop"], "file:..");
});

test("cleanPackage reports an already-clean production manifest", () => {
  const result = cleanPackage({
    name: "docket-backend",
    dependencies: { express: "^4.22.2" },
  });

  assert.equal(result.strippedSelfReference, false);
  assert.deepEqual(result.manifest.dependencies, { express: "^4.22.2" });
});
