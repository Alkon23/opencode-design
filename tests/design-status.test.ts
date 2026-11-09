import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createDesignStatusStore, DESIGN_STATUS_FILE } from "../lib/design-status.ts";
import { startDesignCanvasServer } from "../lib/design-canvas-server.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "design-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, file: join(root, DESIGN_STATUS_FILE), store: createDesignStatusStore(root) };
}

test("request state is durable, idempotent and isolated across session canvases", async t => {
	const { root, file, store } = fixture(t);
	await store.ensure("a");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).requests.length, 0);
	await Promise.all(Array.from({ length: 12 }, (_, i) => createDesignStatusStore(root).queue(i % 2 ? "a" : "b", String(i), "Updating…", ["comment"] )));
	assert.equal((await store.read()).requests.length, 12);
	await store.pickup("a", "1");
	await store.queue("a", "1", "Retry");
	assert.equal((await store.read()).requests.find(r => r.id === "1")!.status, "working");
	await store.pickup("a", "3");
	let doc = await store.read();
	assert.equal(doc.requests.find(r => r.id === "1")!.status, "completed");
	assert.equal(doc.requests.find(r => r.id === "3")!.status, "working");
	assert.ok(doc.requests.filter(r => r.sessionID === "b").every(r => r.status === "queued"));
	const revision = doc.revision;
	await store.pickup("a", "3");
	await store.pickup("a", "unknown");
	assert.equal((await store.read()).revision, revision);
	await store.finish("a", "completed", "Ready");
	doc = await createDesignStatusStore(root).read();
	assert.equal(doc.requests.find(r => r.id === "3")!.status, "completed");
	assert.equal(doc.requests.find(r => r.id === "5")!.status, "queued", "success never completes waiting requests");
});

test("admission ambiguity, retries, failures and cancellations do not fake success", async t => {
	const { store } = fixture(t);
	await store.queue("a", "one", "Feedback");
	await store.admissionFailed("a", "one");
	assert.equal((await store.read()).requests[0].status, "failed");
	await store.pickup("a", "one");
	assert.equal((await store.read()).requests[0].status, "working", "late native pickup beats uncertain delivery response");
	await store.admissionFailed("a", "one");
	assert.equal((await store.read()).requests[0].status, "working");
	await store.finish("a", "failed", "Agent failed");
	await store.queue("a", "one", "Feedback");
	assert.equal((await store.read()).requests.length, 1);
	assert.equal((await store.read()).requests[0].status, "queued");
	await store.cancel("a", "one");
	assert.equal((await store.read()).requests[0].status, "cancelled");
});

test("recovery cannot overwrite newer native events", async t => {
	const { store } = fixture(t);
	await store.queue("a", "one", "Feedback");
	const { revision } = await store.read();
	await store.pickup("a", "one");
	await store.reconcile("a", revision, [{ id: "one", status: "queued", body: "Outdated native snapshot" }]);
	assert.equal((await store.read()).requests[0].status, "working");
});

test("malformed or linked status files are refused without overwrite", async t => {
	const { store, file, root } = fixture(t);
	for (const content of ["{broken", '{"version":1,"revision":0,"sessions":[],"requests":[null]}']) {
		writeFileSync(file, content);
		await assert.rejects(store.ensure("a"), /Invalid/);
		assert.equal(readFileSync(file, "utf8"), content);
	}
	const target = join(root, "outside.json");
	writeFileSync(target, "do not edit");
	rmSync(file);
	try { symlinkSync(target, file); } catch { t.diagnostic("Symlink assertion unavailable without Windows Developer Mode"); return; }
	await assert.rejects(store.ensure("a"), /regular file/);
	assert.equal(readFileSync(target, "utf8"), "do not edit");
});

test("status API filters the originating session and retains token/Origin/method protection", async t => {
	const { root, store } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, sessionID: "a", onComment() {} });
	t.after(() => server.close());
	await store.queue("a", "one", "Feedback");
	await store.queue("b", "two", "Other session");
	const url = new URL(`/${server.token}/api/session-status`, server.url);
	const snapshot = await (await fetch(url)).json();
	assert.equal(snapshot.sessionID, "a");
	assert.deepEqual(snapshot.requests.map((r: { id: string }) => r.id), ["one"]);
	assert.equal((await fetch(url, { headers: { Origin: "null" } })).status, 403);
	assert.equal((await fetch(url, { method: "POST" })).status, 405);
	assert.equal((await fetch(new URL("/wrong/api/session-status", server.url))).status, 404);
	assert.equal((await fetch(new URL(`/${server.token}/assets/request-status.js`, server.url))).status, 200);
});

test("status JSON writes reach the existing live reload stream", async t => {
	const { root, store } = fixture(t);
	const server = await startDesignCanvasServer({ designRoot: root, sessionID: "a", onComment() {} });
	t.after(() => server.close());
	const abort = new AbortController();
	t.after(() => abort.abort());
	const response = await fetch(new URL(`/${server.token}/events`, server.url), { signal: abort.signal });
	const reader = response.body!.getReader();
	await reader.read();
	await store.queue("a", "one", "Feedback");
	const timeout = setTimeout(() => abort.abort(), 3000);
	try {
		const chunk = await reader.read();
		assert.match(new TextDecoder().decode(chunk.value), /session-status\.json/);
	} finally { clearTimeout(timeout); abort.abort(); }
});
