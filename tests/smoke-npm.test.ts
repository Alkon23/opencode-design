import assert from "node:assert/strict";
import test from "node:test";
const { INSTALL_TIMEOUT_MS, PACK_TIMEOUT_MS, runSmokeNpm } = await import(new URL("../scripts/smoke-npm.mjs", import.meta.url).href);

test("package install gets a bounded network-aware budget without changing npm invocation", () => {
  for (const command of ["pack", "install"]) {
    let called = false;
    const output = runSmokeNpm([command, "--ignore-scripts"], "fixture", {
      npmPath: "npm-cli.js",
      spawn(executable: string, args: string[], options: { cwd: string; timeout: number; windowsHide: boolean }) {
        called = true;
        assert.equal(executable, process.execPath);
        assert.deepEqual(args, ["npm-cli.js", command, "--ignore-scripts"]);
        assert.equal(options.cwd, "fixture");
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, command === "install" ? INSTALL_TIMEOUT_MS : PACK_TIMEOUT_MS);
        assert.ok(options.timeout > 0);
        return { status: 0, stdout: "success", stderr: "" };
      },
    });
    assert.equal(called, true);
    assert.equal(output, "success");
  }
  assert.ok(INSTALL_TIMEOUT_MS > 300_000, "budget exceeds npm's default single HTTP timeout");
});

test("package npm failures preserve stdout, stderr and the original timeout cause", () => {
  const timeout = Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" });
  assert.throws(() => runSmokeNpm(["install"], "fixture", {
    npmPath: "npm-cli.js",
    spawn: () => ({ error: timeout, status: null, stdout: "install progress", stderr: "registry retry" }),
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /npm install timed out after 600s/);
    assert.match(error.message, /install progress/);
    assert.match(error.message, /registry retry/);
    assert.equal(error.cause, timeout);
    return true;
  });
  assert.throws(() => runSmokeNpm(["install"], "fixture", {
    npmPath: "npm-cli.js",
    spawn: () => ({ status: 1, stdout: "install progress", stderr: "npm ERR! unavailable" }),
  }), /exited with status 1\ninstall progress\nnpm ERR! unavailable/);
});
