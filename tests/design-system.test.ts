import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readSystemState, runDesignSystemTool, type SystemToken } from "../lib/design-system.ts";
import { createDesignCommentStore, createSystemCommentStore } from "../lib/design-comments.ts";
import { listDesigns, runDesignCommentsTool } from "../lib/design.ts";
import { staleDesignSources } from "../lib/design-sources.ts";
import { trySymlink } from "./helpers.ts";

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-system-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".design", "system"), { recursive: true });
  return cwd;
}
const tokens: SystemToken[] = [{ key: "primary", group: "color", value: "#123456", source: "src/theme.css" }];

test("foundation headings are readable while stable technical keys remain in details", async (t) => {
  const cwd = fixture(t);
  const examples: Array<[string, SystemToken["group"], string, string]> = [
    ["font.size.body", "font", "16px", "Body text size"],
    ["font.line-height.body", "font", "1.5", "Body line height"],
    ["font.size.header", "font", "32px", "Header text size"],
    ["body.weight", "font", "500", "Body weight"],
    ["spacing.entry.indent.compact", "spacing", "8px", "Entry indent · Compact"],
    ["spacing.entry-padding.compact", "spacing", "12px", "Entry padding · Compact"],
    ["component.report.columns.compact", "component", "minmax(0,1fr) 280px", "Report columns · Compact"],
    ["component.report.selected-day", "component", "Highlighted", "Report selected day"],
    ["radius.card", "radius", "8px", "Card"],
    ["shadow.card", "shadow", "none", "Card"],
  ];
  const input = examples.map(([key, group, value]) => ({ key, group, value, source: "theme.css" }));
  await runDesignSystemTool(cwd, { action: "sync", tokens: input });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  for (const [key, , , label] of examples) {
    assert.ok(html.includes(`<h3>${label}</h3>`), `${key} gets a readable title`);
    assert.ok(html.includes(`<summary>Token key</summary><code>${key}</code>`));
    assert.ok(!html.includes(`<h3>${key}</h3>`));
  }
  assert.deepEqual((await readSystemState(join(cwd, ".design"))).source.tokens, input);
  await runDesignSystemTool(cwd, { action: "set", key: "font.size.body", value: "18px" });
  assert.equal((await readSystemState(join(cwd, ".design"))).tokens[0].value, "18px");
});

test("system board separates matched light/dark palettes and previews non-color foundations", async (t) => {
  const cwd = fixture(t);
  const input: SystemToken[] = [
    { key: "dark.canvas", group: "color", value: "#171919", source: "theme.css" },
    { key: "light.canvas", group: "color", value: "#faf8ef", source: "theme.css" },
    { key: "light.accent", group: "color", value: "#bd8500", source: "theme.css" },
    { key: "body.family", group: "font", value: "system-ui", source: "theme.css" },
    { key: "body.size", group: "font", value: "16px", source: "theme.css" },
    { key: "body.weight", group: "font", value: "500", source: "theme.css" },
    { key: "body.line-height", group: "font", value: "1.5", source: "theme.css" },
    { key: "space.md", group: "spacing", value: "16px", source: "theme.css" },
    { key: "radius.card", group: "radius", value: "12px", source: "theme.css" },
    { key: "shadow.card", group: "shadow", value: "0 4px 16px #0003", source: "theme.css" },
    { key: "button.rule", group: "component", value: "Use a visible focus ring", source: "theme.css" },
  ];
  await runDesignSystemTool(cwd, { action: "sync", tokens: input });
  await runDesignSystemTool(cwd, { action: "set", key: "light.accent", value: "#d79f00" });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  for (const heading of ["Light", "Dark", "Typography", "Spacing", "Radii", "Shadows", "Components"]) assert.ok(html.includes(`>${heading}</h`), heading);
  assert.match(html, /data-palette="light"/);
  assert.match(html, /data-palette="dark"/);
  assert.match(html, /font-size:16px/);
  assert.match(html, /font-weight:500/);
  assert.match(html, /line-height:1.5/);
  assert.match(html, /width:16px/);
  assert.match(html, /box-shadow:0 4px 16px #0003/);
  assert.match(html, /Preview override/);
  assert.match(html, /#bd8500/);
  const md = readFileSync(join(cwd, ".design", "system.md"), "utf8");
  assert.match(md, /## Typography/);
  assert.match(md, /## Spacing/);
});

test("color-only sync explicitly reports missing foundations without inventing tokens", async (t) => {
  const cwd = fixture(t);
  const report = await runDesignSystemTool(cwd, { action: "sync", tokens });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  assert.match(html, /Not specified/);
  assert.match(report, /missingGroups/);
  assert.deepEqual((await readSystemState(join(cwd, ".design"))).source.tokens, tokens);
});

test("palette grouping does not mistake semantic dark accents for theme prefixes", async (t) => {
  const cwd = fixture(t);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [
    { key: "accent-dark", group: "color", value: "#123456", source: "theme.css" },
    { key: "light.canvas", group: "color", value: "#ffffff", source: "theme.css" },
  ] });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  const darkPanel = html.slice(html.indexOf('data-palette="dark"'), html.indexOf('class="shared-colors"'));
  assert.doesNotMatch(darkPanel, /data-token-key="accent-dark"/);
  assert.match(darkPanel, /Not specified/);
  assert.match(html, /Shared \/ unthemed/);
});

test("foundation previews never interpret URLs or injected CSS as token styles", async (t) => {
  const cwd = fixture(t);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [
    { key: "body.family", group: "font", value: 'Arial; background:url(https://example.com)', source: "theme.css" },
    { key: "shadow.card", group: "shadow", value: '0 0 2px red; background:url(https://example.com)', source: "theme.css" },
    { key: "component.rule", group: "component", value: '<img src=x onerror=alert(1)>', source: "theme.css" },
  ] });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  assert.doesNotMatch(html, /style="[^"]*url\(/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("overrides survive sync, warn on source changes, deactivate on missing/incompatible sources, and remove restores source", async (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "application.css"), "unchanged");
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  const source = join(cwd, ".design", "system-source.json");
  const stamp = statSync(source).mtimeMs;
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: "#abcdef", reason: "Cooler palette" });
  assert.equal(statSync(source).mtimeMs, stamp);
  let state = await readSystemState(join(cwd, ".design"));
  assert.equal(state.tokens[0].value, "#abcdef");
  assert.equal(state.tokens[0].sourceValue, "#123456");
  assert.match(readFileSync(join(cwd, ".design", "system.html"), "utf8"), /Preview override/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], value: "#111111" }] });
  state = await readSystemState(join(cwd, ".design"));
  assert.equal(state.tokens[0].value, "#abcdef");
  assert.match(state.warnings.join(), /source changed/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [] });
  state = await readSystemState(join(cwd, ".design"));
  assert.equal(state.overrides.overrides.length, 1);
  assert.equal(state.tokens.length, 0);
  assert.match(state.warnings.join(), /missing.*inactive/);
  await runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], group: "spacing", value: "8px" }] });
  assert.match((await readSystemState(join(cwd, ".design"))).warnings.join(), /incompatible/);
  await runDesignSystemTool(cwd, { action: "remove", key: "primary" });
  assert.equal((await readSystemState(join(cwd, ".design"))).tokens[0].value, "8px");
  assert.equal(readFileSync(join(cwd, "application.css"), "utf8"), "unchanged");
});

test("malformed artifacts and invalid tokens refuse mutation without overwriting", async (t) => {
  const cwd = fixture(t);
  await assert.rejects(runDesignSystemTool(cwd, { action: "set", key: "primary", value: "red" }), /Sync/);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  const path = join(cwd, ".design", "system-overrides.json");
  writeFileSync(path, "broken");
  await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens }), /invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "broken");
  writeFileSync(path, '{"version":1,"overrides":[]}');
  for (const bad of [[...tokens, ...tokens], [{ ...tokens[0], source: "../escape.css" }], [{ ...tokens[0], group: "unknown" }]]) {
    await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens: bad as SystemToken[] }));
  }
  assert.deepEqual((await readSystemState(join(cwd, ".design"))).source.tokens, tokens);
});

test("system rendering escapes token content instead of injecting HTML or arbitrary CSS", async (t) => {
  const cwd = fixture(t);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: '</code><script>alert(1)</script>' });
  const html = readFileSync(join(cwd, ".design", "system.html"), "utf8");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("approved reference palette uses proposed sources while invalid provenance paths leave state unchanged", async (t) => {
  const cwd = fixture(t);
  const reference = mkdtempSync(join(tmpdir(), "opencode-palette-reference-"));
  t.after(() => rmSync(reference, { recursive: true, force: true }));
  const stylesheet = join(reference, "styles.css");
  const css = ":root { --primary: #123456; }";
  writeFileSync(stylesheet, css);
  await runDesignSystemTool(cwd, { action: "sync", tokens });
  const sourcePath = join(cwd, ".design", "system-source.json");
  const before = readFileSync(sourcePath, "utf8");
  for (const source of [stylesheet, "D:/dev/dev-tools/src/styles.css", "D:\\dev\\dev-tools\\src\\styles.css", "/reference/styles.css", "../dev-tools/src/styles.css", "https://example.com/styles.css"]) {
    await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], source }] }), /Token source must be project-relative/);
    assert.equal(readFileSync(sourcePath, "utf8"), before, source);
  }
  await runDesignSystemTool(cwd, { action: "sync", tokens: [{ ...tokens[0], source: "proposed" }] });
  assert.equal((await readSystemState(join(cwd, ".design"))).tokens[0].source, "proposed");
  assert.equal(readFileSync(stylesheet, "utf8"), css, "external reference remains read-only");
  assert.match(readFileSync(join(cwd, ".design", "system.md"), "utf8"), /approved starter proposal/);
});

test("new design startup skips nonexistent slug comments until its manifest and proposals exist", async (t) => {
  const cwd = fixture(t);
  const slug = "work-time";
  assert.ok(!listDesigns(cwd).some(design => design.slug === slug));
  await assert.rejects(runDesignCommentsTool(cwd, { action: "list", slug }), /No design "work-time"/);
  const directory = join(cwd, ".design", slug);
  mkdirSync(directory);
  writeFileSync(join(directory, "01-calm.html"), "<h1>Work time</h1>");
  writeFileSync(join(directory, "design.json"), JSON.stringify({ title: "Work time", artboards: [{ file: "01-calm.html", width: 1200, height: 800 }] }));
  assert.ok(listDesigns(cwd).some(design => design.slug === slug));
  const listed = await runDesignCommentsTool(cwd, { action: "list", slug });
  assert.ok("comments" in listed.details);
  assert.deepEqual(listed.details.comments, []);
  await createDesignCommentStore(join(cwd, ".design")).add(slug, { scope: "general", comment: "Keep the approved palette" });
  assert.match((await runDesignCommentsTool(cwd, { action: "list", slug })).text, /Keep the approved palette/);
});

test("derived board symlinks refuse every artifact write", async (t) => {
  const cwd = fixture(t);
  const outside = join(cwd, "outside.html");
  writeFileSync(outside, "do not change");
  if (!trySymlink(outside, join(cwd, ".design", "system.html"))) { t.skip("File symlinks require Windows Developer Mode"); return; }
  await assert.rejects(runDesignSystemTool(cwd, { action: "sync", tokens }), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "do not change");
  assert.equal((await readSystemState(join(cwd, ".design"))).sourceExists, false);
});

test("system and proposal system namespaces isolate same IDs, screenshots, status and resolution", async (t) => {
  const cwd = fixture(t);
  const root = join(cwd, ".design");
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
  utimesSync(join(cwd, ".design", "system-source.json"), 100, 100);
  utimesSync(join(cwd, "tokens.css"), 200, 200);
  await runDesignSystemTool(cwd, { action: "set", key: "primary", value: "red" });
  assert.deepEqual(staleDesignSources(cwd, ["tokens.css"]), ["tokens.css"]);
});

test("system stores reject malformed/wrong-namespace history and screenshot directories that are links", async (t) => {
  const cwd = fixture(t);
  const root = join(cwd, ".design");
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
  const state = await readSystemState(join(cwd, ".design"));
  assert.deepEqual(state.tokens.map((t) => t.value), ["blue", "12px"]);
});
