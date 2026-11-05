import { spawnSync } from "node:child_process";

export const PACK_TIMEOUT_MS = 120_000;
// A clean install may fetch uncached dependencies. npm's default HTTP timeout
// alone is five minutes, so the process budget must exceed the pack budget.
export const INSTALL_TIMEOUT_MS = 600_000;

export function runSmokeNpm(args, cwd, { spawn = spawnSync, npmPath = process.env.npm_execpath } = {}) {
  if (!npmPath) throw new Error("Run through npm run test:package");
  const timeout = args[0] === "install" ? INSTALL_TIMEOUT_MS : PACK_TIMEOUT_MS;
  console.log(`Package smoke: npm ${args[0]} (timeout ${timeout / 1000}s)`);
  const result = spawn(process.execPath, [npmPath, ...args], {
    cwd, encoding: "utf8", timeout, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT"
      ? `timed out after ${timeout / 1000}s`
      : result.error?.message ?? `exited with status ${result.status}${result.signal ? ` (${result.signal})` : ""}`;
    throw new Error([
      `Package smoke: npm ${args[0]} ${reason}`,
      result.stdout?.trim(), result.stderr?.trim(),
    ].filter(Boolean).join("\n"), { cause: result.error });
  }
  return result.stdout;
}
