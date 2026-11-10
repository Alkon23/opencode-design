import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { sendDesignPage } from "../lib/design-pages.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "design-variations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  const path = join(root, "home", "design.json");
  await writeFile(path, JSON.stringify({ title: "Home", importedFrom: { file: "capture.html" }, artboards: [{ file: "original.html" }] }));
  return { root, path, request: { id: "test", parent: { slug: "home", file: "original.html" }, brief: "Try compact", count: 3, mode: "variations" as const } };
}

test("variation reservations never adopt an existing child design", async t => {
  const { root, request } = await fixture(t);
  await mkdir(join(root, "page-test"));
  const file = join(root, "page-test", "variation-test-1.html");
  await writeFile(file, "user work");
  let deliveries = 0;
  const deliver = async () => { deliveries++; };
  await assert.rejects(sendDesignPage(root, request, deliver), /EEXIST/);
  assert.equal(await readFile(file, "utf8"), "user work");
  assert.equal(deliveries, 0);
});

test("variation request retry keeps partial output and metadata; rejects case-colliding IDs", async t => {
  const { root, path, request } = await fixture(t);
  await assert.rejects(sendDesignPage(root, request, async () => { throw new Error("Lost admission"); }), /Lost admission/);
  const output = join(root, "page-test", "variation-test-1.html");
  await writeFile(output, "partial generation");
  const childPath = join(root, "page-test", "design.json");
  const child = JSON.parse(await readFile(childPath, "utf8"));
  child.artboards.push({ file: "variation-test-1.html", title: "Partial" });
  await writeFile(childPath, JSON.stringify(child));
  const original = await readFile(path, "utf8");
  let deliveries = 0;
  const deliver = async () => { deliveries++; };
  await Promise.all([sendDesignPage(root, request, deliver), sendDesignPage(root, request, deliver)]);
  assert.equal(deliveries, 1);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(output, "utf8"), "partial generation");
  assert.deepEqual(JSON.parse(await readFile(childPath, "utf8")), child);
  await assert.rejects(sendDesignPage(root, { ...request, id: "TEST" }, deliver));
});

test("variations create a linked child even when the reference panel is full", async t => {
  const { root, path, request } = await fixture(t);
  await writeFile(path, JSON.stringify({ artboards: [{ file: "original.html" }, ...Array.from({ length: 61 }, (_, i) => ({ file: `${i}.html` }))] }));
  const before = await readFile(path, "utf8");
  const result = await sendDesignPage(root, request, async () => {});
  assert.equal(result.slug, "page-test");
  const child = JSON.parse(await readFile(join(root, result.slug, "design.json"), "utf8"));
  assert.deepEqual(child.parent, request.parent);
  assert.equal(child.requestId, request.id);
  assert.deepEqual(child.artboards, []);
  assert.equal(await readFile(path, "utf8"), before);
});

test("legacy same-panel variation history is retained without redirecting retries", async t => {
  const { root, request } = await fixture(t);
  const file = join(root, "page-requests.json");
  const legacy = { ...request, slug: "home", sent: false };
  await writeFile(file, JSON.stringify({ version: 1, requests: [legacy] }));
  const before = await readFile(file, "utf8");
  await assert.rejects(sendDesignPage(root, request, async () => { assert.fail("must not deliver legacy append"); }), /older variation request/);
  assert.equal(await readFile(file, "utf8"), before);
  const fresh = await sendDesignPage(root, { ...request, id: "fresh" }, async () => {});
  assert.equal(fresh.slug, "page-fresh");
});
