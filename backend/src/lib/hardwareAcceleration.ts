import { safeSpawn } from "./safeSpawn";

export type GpuAcceleration = {
  available: boolean;
  name: string | null;
};

type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ ok: boolean; output: string }>;

async function runCommand(
  command: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = safeSpawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 4_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < 32_000) output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: "" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

function firstUsefulLine(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/**
 * Detects local hardware acceleration before an outline request can reach an
 * LLM. This intentionally checks the machine, not provider configuration: a
 * reachable model endpoint is not evidence that local execution has a GPU.
 */
export async function detectGpuAcceleration(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    run?: CommandRunner;
  } = {},
): Promise<GpuAcceleration> {
  const override = process.env.DOCKET_GPU_AVAILABLE?.trim().toLowerCase();
  if (override === "1" || override === "true") {
    return { available: true, name: "Configured GPU" };
  }
  if (override === "0" || override === "false") {
    return { available: false, name: null };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? runCommand;

  // Every Apple Silicon SoC has an integrated Metal-capable GPU.
  if (platform === "darwin" && arch === "arm64") {
    return { available: true, name: "Apple Silicon GPU" };
  }

  if (platform === "darwin") {
    const probe = await run("system_profiler", ["SPDisplaysDataType"]);
    const match = /Chipset Model:\s*(.+)/i.exec(probe.output);
    const name = match?.[1]?.trim() ?? null;
    return {
      available:
        probe.ok && !!name && /apple|amd|radeon|nvidia|geforce/i.test(name),
      name,
    };
  }

  if (platform === "linux") {
    const nvidia = await run("nvidia-smi", [
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    if (nvidia.ok && firstUsefulLine(nvidia.output)) {
      return { available: true, name: firstUsefulLine(nvidia.output) };
    }
    const rocm = await run("rocminfo", []);
    const rocmName = /^\s*Name:\s*(.+)$/im.exec(rocm.output)?.[1]?.trim();
    if (rocm.ok && rocmName && !/cpu/i.test(rocmName)) {
      return { available: true, name: rocmName };
    }
    return { available: false, name: null };
  }

  if (platform === "win32") {
    const probe = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
    ]);
    const names = probe.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          /nvidia|geforce|amd|radeon|intel\s+arc/i.test(line) &&
          !/microsoft basic|remote display|virtual/i.test(line),
      );
    return {
      available: probe.ok && names.length > 0,
      name: names[0] ?? null,
    };
  }

  return { available: false, name: null };
}
