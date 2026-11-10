import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runSmokeNpm as npm } from "./smoke-npm.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "opencode-design-package-"));
assert.ok(process.env.npm_execpath, "Run through npm run test:package");
try {
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], repository));
  const names = packed.files.map((file) => file.path);
  for (const name of ["src/tui.ts", "src/stop-toast.ts"]) assert.ok(names.includes(name), `Missing TUI file: ${name}`);
  for (const name of ["src/index.ts", "src/plugin.ts", "src/design-agent.ts", "agents/design.md", "lib/design.ts", "assets/design-canvas/index.html", "skills/design/SKILL.md", "skills/design/references/workflow.md", "skills/design/LICENSE", "LICENSE", "NOTICE"]) {
    assert.ok(names.includes(name), `Missing packaged file: ${name}`);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "package-smoke", private: true, type: "module" }));
  npm(["install", join(root, packed.filename), "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  const entry = pathToFileURL(join(root, "node_modules", "opencode-design", "src", "index.ts")).href;
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
    `const { default: plugin } = await import(${JSON.stringify(entry)}); if (plugin.id !== 'opencode-design' || typeof plugin.setup !== 'function') throw Error('Invalid plugin export'); const { loadDesignAgent } = await import(new URL('./design-agent.ts', ${JSON.stringify(entry)})); const agent = await loadDesignAgent(); if (!agent.system.includes('.spec/SPEC.md') || agent.mode !== 'primary') throw Error('Invalid bundled agent');`,
  ], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log(`Package smoke passed: ${packed.entryCount} files, clean tarball install, native plugin export.`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
