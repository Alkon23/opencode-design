import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { importDesign, importFilePath, MAX_IMPORT_BYTES } from "../lib/design-import.ts";
import { parseDesignArgs } from "../lib/design.ts";
import { readDesignManifest } from "../lib/design-canvas-server.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "design-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("import references preserve quoted spaces, @paths and file URIs; reject URLs", async t => {
  const root = await fixture(t);
  const file = join(root, "My  dashboard.html");
  const args = parseDesignArgs('import @"My  dashboard.html"');
  assert.deepEqual(args, { kind: "subcommand", name: "import", rest: '@"My  dashboard.html"' });
  assert.equal(importFilePath(root, '@"My  dashboard.html"'), file);
  assert.equal(importFilePath(root, pathToFileURL(file).href), file);
  assert.throws(() => importFilePath(root, "https://example.org/page.html"), /local HTML/);
  assert.throws(() => importFilePath(root, '"unclosed.html'), /quoted/);
  assert.throws(() => importFilePath(root, "source.tsx"), /snapshot/);
  assert.throws(() => importFilePath(root, ""), /Usage/);
});

test("import initializes a single-artboard design with byte-identical HTML and provenance", async t => {
  const root = await fixture(t);
  const source = join(root, "Dashboard.html");
  const html = '<!doctype html><html><head><style>body{color:#123;background:url( "data:image/png;base64,AA==" )}</style></head><body><h1>Welcome, María</h1><img src="data:image/png;base64,AA=="></body></html>';
  await writeFile(source, html);
  const result = await importDesign(root, source);
  assert.equal(result.slug, "dashboard");
  await assert.rejects(readFile(join(root, "design", result.slug, "design.json")), /ENOENT/, "imports must not create the legacy output directory");
  assert.equal(result.warnings.length, 1, "embedded assets are not reported as external dependencies");
  assert.equal(await readFile(source, "utf8"), html);
  assert.equal(await readFile(join(root, ".design", result.slug, "01-original.html"), "utf8"), html);
  const manifest = readDesignManifest(join(root, ".design"), result.slug);
  assert.equal(manifest.artboards.length, 1);
  const raw = JSON.parse(await readFile(join(root, ".design", result.slug, "design.json"), "utf8"));
  assert.equal(raw.importedFrom.file, source);
  assert.match(raw.importedFrom.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await importDesign(root, source)).slug, "dashboard-2");
  assert.equal((await Promise.all([importDesign(root, source), importDesign(root, source)])).map(r => r.slug).join(","), "dashboard-3,dashboard-4");
});

test("import rejects invalid, oversized and non-UTF8 inputs before initializing designs", async t => {
  const root = await fixture(t);
  const source = join(root, "bad.html");
  await writeFile(source, "const App = () => <div>Hello</div>");
  await assert.rejects(importDesign(root, source), /not an HTML/);
  await writeFile(source, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(importDesign(root, source), /UTF-8/);
  await truncate(source, MAX_IMPORT_BYTES + 1);
  await assert.rejects(importDesign(root, source), /32 MiB/);
  await assert.rejects(readFile(join(root, ".design", "bad", "design.json")), /ENOENT/);
});

test("import warns about dependencies and refuses a redirected design root", async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  const source = join(root, "export.html");
  await writeFile(source, '<html><body><img src="https://example.org/avatar.png"></body></html>');
  assert.match((await importDesign(other, source)).warnings.join(" "), /non-embedded/);
  await symlink(join(other, ".design"), join(root, ".design"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(importDesign(root, source), /symbolic link/);
});
