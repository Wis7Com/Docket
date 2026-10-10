import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRerankServerManager,
  findLlamaServerBinary,
  resolveRerankModelPath,
  type RerankServerManager,
} from "./rerankServer";

// ---------------------------------------------------------------------------
// Harness: virtual clock, fake child processes, fake health endpoint.
// ---------------------------------------------------------------------------

type FakeTimer = {
  at: number;
  fn: () => void;
  cancelled: boolean;
  unref: () => FakeTimer;
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createClock() {
  let current = 1_000;
  const timers: FakeTimer[] = [];
  const deps = {
    now: () => current,
    setTimeout: (fn: () => void, ms: number) => {
      const timer: FakeTimer = {
        at: current + ms,
        fn,
        cancelled: false,
        unref() {
          return timer;
        },
      };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimeout: (timer: NodeJS.Timeout) => {
      (timer as unknown as FakeTimer).cancelled = true;
    },
  };

  /** Moves virtual time forward, running due timers and letting promises settle. */
  async function advance(ms: number): Promise<void> {
    const target = current + ms;
    for (;;) {
      await flush();
      let next: FakeTimer | null = null;
      for (const timer of timers) {
        if (timer.cancelled || timer.at > target) continue;
        if (!next || timer.at < next.at) next = timer;
      }
      if (!next) break;
      current = Math.max(current, next.at);
      next.cancelled = true;
      next.fn();
    }
    current = target;
    await flush();
  }

  /** Advances time in small steps until the promise settles. */
  async function drive<T>(
    promise: Promise<T>,
    stepMs = 10,
    maxMs = 120_000,
  ): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    promise.then(
      (v) => {
        settled = true;
        value = v;
      },
      (e: unknown) => {
        settled = true;
        error = e;
      },
    );
    for (let elapsed = 0; !settled && elapsed <= maxMs; elapsed += stepMs) {
      await advance(stepMs);
    }
    assert.ok(settled, "promise did not settle within the virtual time budget");
    if (error) throw error;
    return value as T;
  }

  return { deps, advance, drive };
}

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  stderr = new EventEmitter();
  signals: string[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    setImmediate(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

type Behaviour = {
  /** `/health` polls answered with HTTP 503 before the first 200. Infinity = never healthy. */
  healthFailures: number;
  /** When set, a new child exits on its own this many ms-of-event-loop after spawn. */
  exitOnSpawn: boolean;
  errorOnSpawn: Error | null;
};

function createHarness(
  options: {
    idleSeconds?: number;
    startupTimeoutMs?: number;
    pollMs?: number;
  } = {},
  behaviour: Partial<Behaviour> = {},
) {
  const clock = createClock();
  const state: Behaviour = {
    healthFailures: 2,
    exitOnSpawn: false,
    errorOnSpawn: null,
    ...behaviour,
  };
  const children: FakeChild[] = [];
  const spawnCalls: { binary: string; args: string[] }[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const healthUrls: string[] = [];
  let healthPolls = 0;
  let port = 41_000;

  const manager: RerankServerManager = createRerankServerManager({
    ...clock.deps,
    spawn: (binary, args) => {
      spawnCalls.push({ binary, args });
      const child = new FakeChild(9_000 + children.length);
      children.push(child);
      if (state.exitOnSpawn) setImmediate(() => child.emit("exit", 1, null));
      const error = state.errorOnSpawn;
      if (error) setImmediate(() => child.emit("error", error));
      return child as never;
    },
    fetch: async (url) => {
      healthUrls.push(url);
      healthPolls += 1;
      return healthPolls > state.healthFailures
        ? { ok: true, status: 200 }
        : { ok: false, status: 503 };
    },
    pickFreePort: async () => (port += 1),
    log: (message) => void logs.push(message),
    warn: (message) => void warnings.push(message),
    pidFilePath: null,
    installExitHooks: false,
    startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
    healthPollIntervalMs: options.pollMs ?? 250,
  });

  const ensureOptions = (extra: { modelPath?: string } = {}) => ({
    binaryPath: "/fake/llama-server",
    modelPath: extra.modelPath ?? "/fake/model.gguf",
    idleSeconds: options.idleSeconds ?? 600,
  });

  return {
    ...clock,
    manager,
    state,
    children,
    spawnCalls,
    warnings,
    logs,
    healthUrls,
    ensureOptions,
    resetHealth(failures: number) {
      healthPolls = 0;
      state.healthFailures = failures;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("ensure() spawns once with rerank args on the picked port and reports running", async () => {
  const h = createHarness();
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.deepEqual(handle, { baseUrl: "http://127.0.0.1:41001" });
  assert.equal(h.spawnCalls.length, 1);
  const { binary, args } = h.spawnCalls[0];
  assert.equal(binary, "/fake/llama-server");
  assert.ok(args.includes("--rerank"));
  assert.equal(args[args.indexOf("-m") + 1], "/fake/model.gguf");
  assert.equal(args[args.indexOf("--port") + 1], "41001");
  assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
  assert.ok(
    h.healthUrls.every((url) => url === "http://127.0.0.1:41001/health"),
  );
  assert.ok(h.healthUrls.length >= 3, "should poll until the 503s are over");
  const state = h.manager.getState();
  assert.equal(state.status, "running");
  assert.equal(state.baseUrl, "http://127.0.0.1:41001");
  assert.equal(state.pid, 9_000);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastError, null);
});

test("status is 'starting' while the health check is still failing", async () => {
  const h = createHarness({}, { healthFailures: 4 });
  const pending = h.manager.ensure(h.ensureOptions());
  await h.advance(10);
  assert.equal(h.manager.getState().status, "starting");
  await h.drive(pending);
  assert.equal(h.manager.getState().status, "running");
});

test("concurrent ensure() calls share one spawn and one base URL", async () => {
  const h = createHarness();
  const [a, b] = await h.drive(
    Promise.all([
      h.manager.ensure(h.ensureOptions()),
      h.manager.ensure(h.ensureOptions()),
    ]),
  );
  assert.equal(h.spawnCalls.length, 1);
  assert.ok(a && b);
  assert.equal(a.baseUrl, b.baseUrl);
});

test("a second ensure() after the first resolved does not spawn again", async () => {
  const h = createHarness();
  const first = await h.drive(h.manager.ensure(h.ensureOptions()));
  const second = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual(second, first);
});

test("ensure() with a different model path restarts the sidecar", async () => {
  const h = createHarness();
  await h.drive(h.manager.ensure(h.ensureOptions()));
  h.resetHealth(0);
  const second = await h.drive(
    h.manager.ensure(h.ensureOptions({ modelPath: "/fake/other.gguf" })),
  );
  assert.equal(h.spawnCalls.length, 2);
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
  assert.equal(
    h.spawnCalls[1].args[h.spawnCalls[1].args.indexOf("-m") + 1],
    "/fake/other.gguf",
  );
  assert.equal(second?.baseUrl, "http://127.0.0.1:41002");
  assert.equal(h.manager.getState().status, "running");
});

// ---------------------------------------------------------------------------
// Idle timer
// ---------------------------------------------------------------------------

test("the idle timer terminates the sidecar after idleSeconds", async () => {
  const h = createHarness({ idleSeconds: 1 });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(h.manager.getState().status, "running");
  await h.advance(999);
  assert.equal(h.manager.getState().status, "running");
  assert.deepEqual(h.children[0].signals, []);
  await h.advance(1);
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
  const state = h.manager.getState();
  assert.equal(state.status, "stopped");
  assert.equal(state.baseUrl, null);
  assert.equal(state.pid, null);
});

test("markUsed() re-arms the idle timer", async () => {
  const h = createHarness({ idleSeconds: 1 });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  await h.advance(600);
  h.manager.markUsed();
  await h.advance(600);
  assert.equal(h.manager.getState().status, "running");
  assert.deepEqual(h.children[0].signals, []);
  await h.advance(500);
  assert.equal(h.manager.getState().status, "stopped");
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
});

test("an in-flight request keeps the sidecar alive past the idle window", async () => {
  const h = createHarness({ idleSeconds: 1 });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  h.manager.beginRequest();
  await h.advance(1_500);
  assert.equal(h.manager.getState().status, "running");
  assert.equal(h.children[0].signals.length, 0);
  h.manager.endRequest();
  await h.advance(600);
  assert.equal(h.manager.getState().status, "running");
  await h.advance(500);
  assert.equal(h.manager.getState().status, "stopped");
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
});

test("ensure() on a running sidecar also re-arms the idle timer", async () => {
  const h = createHarness({ idleSeconds: 1 });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  await h.advance(800);
  await h.drive(h.manager.ensure(h.ensureOptions()));
  await h.advance(800);
  assert.equal(h.manager.getState().status, "running");
  await h.advance(300);
  assert.equal(h.manager.getState().status, "stopped");
});

test("after an idle stop, the next ensure() spawns a fresh sidecar", async () => {
  const h = createHarness({ idleSeconds: 1 });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  await h.advance(1000);
  assert.equal(h.manager.getState().status, "stopped");
  h.resetHealth(0);
  await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.manager.getState().status, "running");
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

test("a child that exits during start-up resolves null, warns, and counts one failure", async () => {
  const h = createHarness({}, { healthFailures: Infinity, exitOnSpawn: true });
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(handle, null);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /exited during start-up/);
  const state = h.manager.getState();
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.status, "stopped");
  assert.match(state.lastError ?? "", /exited during start-up/);
  assert.equal(h.manager.isDisabled(), false);
});

test("three consecutive start-up failures disable the sidecar; a fourth ensure() does not spawn", async () => {
  const h = createHarness({}, { healthFailures: Infinity, exitOnSpawn: true });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(await h.drive(h.manager.ensure(h.ensureOptions())), null);
    assert.equal(h.manager.getState().consecutiveFailures, attempt);
  }
  assert.equal(h.spawnCalls.length, 3);
  assert.equal(h.manager.isDisabled(), true);
  assert.equal(h.manager.getState().status, "disabled");
  assert.match(h.warnings[h.warnings.length - 1], /disabled for this session/);

  assert.equal(await h.drive(h.manager.ensure(h.ensureOptions())), null);
  assert.equal(h.spawnCalls.length, 3, "disabled manager must not spawn");
});

test("a successful start resets the failure counter", async () => {
  const h = createHarness({}, { healthFailures: Infinity, exitOnSpawn: true });
  await h.drive(h.manager.ensure(h.ensureOptions()));
  await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(h.manager.getState().consecutiveFailures, 2);
  h.state.exitOnSpawn = false;
  h.resetHealth(0);
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.ok(handle);
  assert.equal(h.manager.getState().consecutiveFailures, 0);
  assert.equal(h.manager.isDisabled(), false);
});

test("a start-up timeout resolves null and kills the child", async () => {
  const h = createHarness(
    { startupTimeoutMs: 50, pollMs: 5 },
    { healthFailures: Infinity },
  );
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()), 5, 5_000);
  assert.equal(handle, null);
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /did not become healthy/);
  assert.equal(h.manager.getState().consecutiveFailures, 1);
  assert.equal(h.manager.getState().status, "stopped");
});

test("stderr from the child is included in the start-up failure message", async () => {
  const h = createHarness(
    { startupTimeoutMs: 50, pollMs: 5 },
    { healthFailures: Infinity },
  );
  const pending = h.manager.ensure(h.ensureOptions());
  await h.advance(1);
  h.children[0].stderr.emit(
    "data",
    Buffer.from("error: bad model\nsecond line\n"),
  );
  await h.drive(pending, 5, 5_000);
  assert.match(h.warnings[0], /bad model/);
});

test("a spawn 'error' event (e.g. ENOENT) resolves null instead of hanging", async () => {
  const h = createHarness(
    {},
    { healthFailures: Infinity, errorOnSpawn: new Error("spawn ENOENT") },
  );
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(handle, null);
  assert.match(h.warnings[0], /ENOENT/);
  assert.equal(h.manager.getState().consecutiveFailures, 1);
});

test("an unexpected exit after start returns to 'stopped' and the next ensure() respawns", async () => {
  const h = createHarness();
  await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.equal(h.manager.getState().status, "running");

  h.children[0].emit("exit", 137, null);
  await h.advance(0);
  const state = h.manager.getState();
  assert.equal(state.status, "stopped");
  assert.equal(state.consecutiveFailures, 0);
  assert.match(h.warnings[h.warnings.length - 1], /exited unexpectedly/);

  h.resetHealth(0);
  const handle = await h.drive(h.manager.ensure(h.ensureOptions()));
  assert.ok(handle);
  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.manager.getState().status, "running");
  assert.equal(h.manager.getState().consecutiveFailures, 0);
});

test("a stale exit event from a replaced child does not clobber the new one", async () => {
  const h = createHarness();
  await h.drive(h.manager.ensure(h.ensureOptions()));
  h.children[0].emit("exit", 1, null);
  h.resetHealth(0);
  await h.drive(h.manager.ensure(h.ensureOptions()));
  const secondBase = h.manager.getState().baseUrl;
  h.children[0].emit("exit", 1, null);
  await h.advance(0);
  assert.equal(h.manager.getState().status, "running");
  assert.equal(h.manager.getState().baseUrl, secondBase);
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test("stop() kills a running sidecar and clears its state", async () => {
  const h = createHarness();
  await h.drive(h.manager.ensure(h.ensureOptions()));
  h.manager.stop("test");
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
  const state = h.manager.getState();
  assert.equal(state.status, "stopped");
  assert.equal(state.baseUrl, null);
  assert.equal(state.pid, null);
  assert.ok(h.logs.some((line) => line.includes("(test)")));
  // The idle timer is gone, so advancing time must not send a second signal.
  await h.advance(10 * 60_000);
  assert.deepEqual(h.children[0].signals, ["SIGTERM"]);
});

test("stop() on an idle manager is a no-op", () => {
  const h = createHarness();
  assert.doesNotThrow(() => h.manager.stop("nothing running"));
  assert.equal(h.manager.getState().status, "stopped");
  assert.equal(h.spawnCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("findLlamaServerBinary returns null for a missing explicit path", () => {
  assert.equal(findLlamaServerBinary("/definitely/not/here"), null);
});

test("findLlamaServerBinary accepts an executable file and rejects a non-executable one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-rerank-bin-"));
  try {
    const exe = path.join(dir, "llama-server");
    fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(exe, 0o755);
    assert.equal(findLlamaServerBinary(exe), exe);

    const plain = path.join(dir, "not-executable");
    fs.writeFileSync(plain, "x");
    fs.chmodSync(plain, 0o644);
    assert.equal(findLlamaServerBinary(plain), null);
    assert.equal(
      findLlamaServerBinary(dir),
      null,
      "a directory is not a binary",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findLlamaServerBinary searches PATH when nothing is configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-rerank-path-"));
  const originalPath = process.env.PATH;
  try {
    const exe = path.join(dir, "llama-server");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    fs.chmodSync(exe, 0o755);
    process.env.PATH = dir;
    assert.equal(findLlamaServerBinary(null), exe);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRerankModelPath returns null for a missing explicit file and the path for an existing one", () => {
  assert.equal(resolveRerankModelPath("/definitely/not/here.gguf"), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-rerank-model-"));
  try {
    const model = path.join(dir, "m.gguf");
    fs.writeFileSync(model, "gguf");
    assert.equal(resolveRerankModelPath(model), model);
    assert.equal(
      resolveRerankModelPath(dir),
      null,
      "a directory is not a model file",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
