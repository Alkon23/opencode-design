import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readSystemState, runDesignSystemTool, type SystemToken } from "../lib/design-system.ts";
import { createDesignCommentStore, createSystemCommentStore } from "../lib/design-comments.ts";
import { runDesignCommentsTool } from "../lib/design.ts";
import { staleDesignSources } from "../lib/design-sources.ts";
import { trySymlink } from "./helpers.ts";

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-system-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "design", "system"), { recursive: true });
  return cwd;
}
const tokens: SystemToken[] = [{ key: "primary", group: "color", value: "#123456", source: "src/theme.css" }];

test("overrides survive sync, warn on source changes, deactivate on missing/incompatible sources, and remove restores source", async (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "application.css"), "unchanged");
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  const source = join(cwd, "design", "system-source.json");
  const stamp = statSync(source).mtimeMs;
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: "#abcdef", reason: "Cooler palette" });
  assert.equal(statSync(source).mtimeMs, stamp);
  let state = await readSystemState(join(cwd, "design"));
  assert.equal(state.tokens[0].value, "#abcdef");
  assert.equal(state.tokens[0].sourceValue, "#123456");
  assert.match(readFileSync(join(cwd, "design", "system.html"), "utf8"), /Preview override/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], value: "#111111" }] });
  state = await readSystemState(join(cwd, "design"));
  assert.equal(state.tokens[0].value, "#abcdef");
  assert.match(state.warnings.join(), /source changed/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [] });
  state = await readSystemState(join(cwd, "design"));
  assert.equal(state.overrides.overrides.length, 1);
  assert.equal(state.tokens.length, 0);
  assert.match(state.warnings.join(), /missing.*inactive/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], group: "spacing", value: "8px" }] });
  assert.match((await readSystemState(join(cwd, "design"))).warnings.join(), /incompatible/);
  await runDesignSystemTool(cwd, { action: "remove", key: "primary" });
  assert.equal((await readSystemState(join(cwd, "design"))).tokens[0].value, "8px");
  assert.equal(readFileSync(join(cwd, "application.css"), "utf8"), "unchanged");
});

test("malformed artifacts and invalid tokens refuse mutation without overwriting", async (t) => {
  const cwd = fixture(t);
  await assert.rejects(runDesignSystemTool(cwd, { action: "set", key: "primary", value: "red" }), /Sync/);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  const path = join(cwd, "design", "system-overrides.json");
  writeFileSync(path, "broken");
  await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens }), /invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "broken");
  writeFileSync(path, '{"version":1,"overrides":[]}');
  for (const bad of [[...tokens, ...tokens], [{ ...tokens[0], source: "../escape.css" }], [{ ...tokens[0], group: "unknown" }]]) {
    await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens: bad as SystemToken[] }));
  }
  assert.deepEqual((await readSystemState(join(cwd, "design"))).source.tokens, tokens);
});

test("system rendering escapes token content instead of injecting HTML or arbitrary CSS", async (t) => {
  const cwd = fixture(t);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: '</code><script>alert(1)</script>' });
  const html = readFileSync(join(cwd, "design", "system.html"), "utf8");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("derived board symlinks refuse every artifact write", async (t) => {
  const cwd = fixture(t);
  const outside = join(cwd, "outside.html");
  writeFileSync(outside, "do not change");
  if (!trySymlink(outside, join(cwd, "design", "system.html"))) { t.skip("File symlinks require Windows Developer Mode"); return; }
  await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens }), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "do not change");
  assert.equal((await readSystemState(join(cwd, "design"))).sourceExists, false);
});

test("system and proposal system namespaces isolate same IDs, screenshots, status and resolution", async (t) => {
  const cwd = fixture(t);
  const root = join(cwd, "design");
  const deps = { randomId: () => "sameid" };
  const system = createSystemCommentStore(root, deps);
  const proposal = createDesignCommentStore(root, deps);
  const image = { mimeType: "image/png", data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]) };
  await system.add("", { scope: "system", comment: "Change fonts", selector: "h1", excerpt: "Heading", screenshot: image });
  await proposal.add("system", { scope: "general", comment: "Add footer" });
  assert.match((await system.readScreenshot("", "sameid"))!.path, /^\.system-screenshots\//);
  await runDesignCommentsTool(cwd, { action: "resolve", scope: "system", ids: ["sameid"] });
  assert.equal((await system.read("")).comments[0].status, "resolved");
  assert.equal((await proposal.read("system")).comments[0].status, "open");
  await assert.rejects(system.add("", { scope: "general", comment: "wrong" }), /namespace/);
  await assert.rejects(proposal.add("system", { scope: "system", comment: "wrong" }), /namespace/);
  await assert.rejects(runDesignCommentsTool(cwd, { action: "list", scope: "system", slug: "system" }), /omit slug/);
});

test("source freshness uses the extraction snapshot, not later override output", async (t) => {
  const cwd = fixture(t);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  writeFileSync(join(cwd, "tokens.css"), ":root{--primary:red}");
  utimesSync(join(cwd, "design", "system-source.json"), 100, 100);
  utimesSync(join(cwd, "tokens.css"), 200, 200);
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: "red" });
  assert.deepEqual(staleDesignSources(cwd, ["tokens.css"]), ["tokens.css"]);
});

test("system stores reject malformed/wrong-namespace history and screenshot directories that are links", async (t) => {
  const cwd = fixture(t);
  const root = join(cwd, "design");
  const store = createSystemCommentStore(root);
  const path = join(root, "system-comments.json");
  await store.add("", { scope: "system", comment: "Spacing" });
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.comments[0].scope = "general";
  const bad = JSON.stringify(document);
  writeFileSync(path, bad);
  await assert.rejects(store.add("", { scope: "system", comment: "New" }), /namespace/);
  assert.equal(readFileSync(path, "utf8"), bad);
  writeFileSync(path, '{"version":1,"comments":[]}');
  const outside = join(cwd, "outside-shots");
  mkdirSync(outside);
  if (!trySymlink(outside, join(root, ".system-screenshots"))) { t.skip("Symlinks unavailable"); return; }
  await assert.rejects(store.add("", { scope: "system", comment: "Screenshot", screenshot: {
    mimeType: "image/png", data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]),
  } }), /directory/);
  assert.equal((await store.read("")).comments.length, 0);
});

test("missing roots list safely and concurrent override changes preserve both values", async (t) => {
  const cwd = fixture(t);
  assert.deepEqual((await createSystemCommentStore(join(cwd, "missing")).read("")).comments, []);
  const extra = { key: "space", group: "spacing" as const, value: "8px", source: "theme.css" };
  await runDesignSystemTool(cwd, { action: "sync", tokens: [...tokens, extra] });
  await Promise.all([
    runDesignSystemTool(cwd, { action: "set", key: "primary", value: "blue" }),
    runDesignSystemTool(cwd, { action: "set", key: "space", value: "12px" }),
  ]);
  const state = await readSystemState(join(cwd, "design"));
  assert.deepEqual(state.tokens.map((t) => t.value), ["blue", "12px"]);
});
