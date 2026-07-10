import test from "node:test";
import assert from "node:assert/strict";
import { detectGpuAcceleration } from "./hardwareAcceleration";

test("Apple Silicon is recognized without launching a hardware probe", async () => {
  let commandCalls = 0;
  const result = await detectGpuAcceleration({
    platform: "darwin",
    arch: "arm64",
    run: async () => {
      commandCalls += 1;
      return { ok: false, output: "" };
    },
  });

  assert.equal(commandCalls, 0);
  assert.equal(result.available, true);
  assert.match(result.name ?? "", /Apple Silicon/i);
});

test("Linux with no accelerator tools or render device is CPU-only", async () => {
  const commands: string[] = [];
  const result = await detectGpuAcceleration({
    platform: "linux",
    arch: "x64",
    run: async (command) => {
      commands.push(command);
      return { ok: false, output: "" };
    },
  });

  assert.deepEqual(commands, ["nvidia-smi", "rocminfo"]);
  assert.deepEqual(result, { available: false, name: null });
});
