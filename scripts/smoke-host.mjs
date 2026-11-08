import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

// Own a separate service registration and home. Never touch the user's shared
// service, credentials, or configuration; make no model calls.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "opencode-design-host-"));
const file = join(root, "state", "opencode", "service.json");
const env = {
  HOME: root, USERPROFILE: root,
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
};
let binary = process.env.OPENCODE_BIN || "opencode";
if (process.platform === "win32" && !process.env.OPENCODE_BIN) {
  binary = (process.env.PATH || "").split(delimiter).map((path) => join(path, "opencode.exe")).find(existsSync) || binary;
}

try {
  writeFileSync(join(root, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: repository, options: { openBrowser: false } }],
  }));
  const endpoint = await Service.ensure({ file, command: [binary, "serve", "--service", "--port", "0"], env });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const input = { location: { directory: root } };
  // Registry reads can precede asynchronous plugin activation on first Location boot.
  const deadline = Date.now() + 30_000;
  let skills;
  do {
    skills = (await client.skill.list(input)).data;
    if (skills.some((item) => item.id === "opencode-design")) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.ok(skills.some((item) => item.id === "opencode-design"), JSON.stringify(await client.plugin.list(input)));
  const agent = (await client.agent.list(input)).data.find(item => item.id === "design");
  assert.ok(agent, "Plugin registers Design without a copied agent file");
  assert.equal(agent.name, "Design");
  assert.equal(agent.mode, "primary");
  assert.match(agent.system, /implementation not started/);
  assert.ok(agent.permissions.some(rule => rule.action === "edit" && rule.resource.replaceAll("\\", "/") === join(root, "spec", "*.md").replaceAll("\\", "/") && rule.effect === "allow"));
  const collision = join(root, "custom-agent-project");
  mkdirSync(collision);
  writeFileSync(join(collision, "opencode.json"), JSON.stringify({
    agents: { design: { mode: "primary", system: "User-owned Design instructions" } },
  }));
  const collisionInput = { location: { directory: collision } };
  const collisionDeadline = Date.now() + 30_000;
  let active = false;
  do {
    active = (await client.plugin.list(collisionInput)).data.some(item => item.id === "opencode-design" && item.state.status === "active");
    if (!active) await new Promise(r => setTimeout(r, 100));
  } while (!active && Date.now() < collisionDeadline);
  assert.ok(active, "Plugin activated alongside a configured Design agent");
  const custom = (await client.agent.list(collisionInput)).data.find(item => item.id === "design");
  assert.equal(custom?.system, "User-owned Design instructions", "Plugin preserves a configured Design collision");
  const commands = (await client.command.list(input)).data;
  assert.ok(commands.some((item) => item.name === "design"));
  const design = join(root, "design", "landing");
  mkdirSync(design, { recursive: true });
  writeFileSync(join(design, "01-calm.html"), "<!doctype html><html><body><h1>Hello</h1></body></html>");
  writeFileSync(join(design, "design.json"), JSON.stringify({ title: "Smoke", artboards: [
    { file: "01-calm.html", title: "Calm", width: 1200, height: 800 },
  ] }));
  const session = await client.session.create({
    location: { directory: root }, title: "Design plugin smoke",
    permissions: [{ action: "design_canvas", resource: "*", effect: "allow" }],
  });
  try {
    await client.session.switchAgent({ sessionID: session.id, agent: "design" });
    await client.session.command({ sessionID: session.id, name: "design", text: "open landing" });
    let canvasURL;
    const until = Date.now() + 10_000;
    do {
      const context = JSON.stringify(await client.session.inbox.list({ sessionID: session.id }));
      canvasURL = context.match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/d\/landing\//)?.[0];
      if (canvasURL) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < until);
    assert.ok(canvasURL, "Canvas notice reached the native session inbox without starting a model");
    assert.equal((await fetch(canvasURL)).status, 200);
    await client.session.command({ sessionID: session.id, name: "design", text: "stop" });
    await assert.rejects(fetch(canvasURL));
  } finally {
    await client.session.remove({ sessionID: session.id });
  }
  console.log("OpenCode host smoke passed: native Design agent + policy, skill, /design open + stop, session notices, real canvas HTTP (no model calls).");
} finally {
  await Service.stop({ file });
  try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
  catch (error) { console.error(`Could not remove smoke fixture ${root}: ${error.message}`); }
}
