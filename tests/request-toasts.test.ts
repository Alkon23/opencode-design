import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

class Element {
	className = "";
	textContent = "";
	hidden = false;
	children: Element[] = [];
	parent?: Element;
	append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
	setAttribute() {}
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
}
function setup({ motion = false, reduced = false } = {}) {
	const container = new Element();
	const animations: Array<{ frames: any[]; duration: number; finish: () => void; cancelled: boolean }> = [];
	const createElement = () => {
		const element = new Element();
		if (motion) Object.assign(element, { animate(frames: any[], options: { duration: number }) {
			let finish!: () => void;
			let reject!: () => void;
			const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = () => fail(new Error("cancelled")); });
			const animation = { frames, duration: options.duration, finish, cancelled: false };
			animations.push(animation);
			return { finished, cancel: () => { animation.cancelled = true; reject(); } };
		} });
		return element;
	};
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let timerID = 0;
	const window: any = { matchMedia: () => ({ matches: reduced }) };
	vm.runInNewContext(readFileSync(new URL("../assets/design-canvas/request-status.js", import.meta.url), "utf8"), {
		window, document: { createElement },
		setTimeout: (fn: () => void, ms: number) => { timers.set(++timerID, { fn, ms }); return timerID; },
		clearTimeout: (id: number) => timers.delete(id),
	});
	let snapshot: any = { revision: 0, requests: [] };
	let refresh: () => Promise<void> = async () => {};
	let refreshes = 0;
	const errors: unknown[] = [];
	const controller = window.createDesignRequestToasts({ container, read: async () => snapshot,
		refresh: () => { refreshes++; return refresh(); }, reportError: (e: unknown) => errors.push(e) });
	return { container, timers, errors, controller, animations, get refreshes() { return refreshes; },
		setRefresh: (fn: () => Promise<void>) => { refresh = fn; },
		load: (revision: number, requests: unknown[]) => { snapshot = { revision, requests }; return controller.load(); },
	};
}
const request = (id: string, status: string) => ({ id, status, body: "Updating layouts…" });
const title = (card: Element) => card.children[1].children[0].textContent;

test("request toasts are inside the canvas viewport, separate from the comments sidebar", () => {
	const html = readFileSync(new URL("../assets/design-canvas/index.html", import.meta.url), "utf8");
	const viewport = html.match(/<main\b[^>]*id="gd-viewport"[^>]*>([\s\S]*?)<\/main>/)?.[1];
	assert.ok(viewport);
	assert.match(viewport, /id="gd-request-toasts"/);
	assert.doesNotMatch(viewport, /id="gd-panel"/);
	assert.equal((html.match(/id="gd-request-toasts"/g) ?? []).length, 1);
});

test("toast stack clips slide-in horizontal overflow but still scrolls queued requests vertically", () => {
	const css = readFileSync(new URL("../assets/design-canvas/canvas.css", import.meta.url), "utf8");
	const stack = css.match(/\.gd-request-toasts\s*\{([^}]+)\}/)?.[1];
	assert.ok(stack);
	assert.match(stack, /overflow-x:\s*hidden/);
	assert.match(stack, /overflow-y:\s*auto/);
});

test("quiet stack hides review/history and preserves individual cards through queue pickup", async () => {
	const h = setup();
	await h.load(0, [request("old", "completed")]);
	assert.equal(h.container.children.length, 0);
	await h.load(1, [request("a", "working"), request("b", "queued")]);
	const [a, b] = h.container.children;
	assert.equal(title(a), "Working");
	assert.equal(a.children[1].children[2].hidden, false);
	assert.equal(title(b), "Request queued");
	assert.equal(b.children[1].children[2].hidden, true);
	await h.load(2, [request("a", "completed"), request("b", "working")]);
	assert.equal(h.container.children[1], b, "pickup updates the same DOM card");
	assert.equal(title(b), "Working");
	assert.equal(title(a), "Request completed");
	assert.equal(h.refreshes, 1);
	const timer = [...h.timers.values()][0];
	assert.equal(timer.ms, 1000);
	timer.fn();
	assert.equal(h.container.children.length, 1);
	await h.load(2, [request("a", "completed"), request("b", "working")]);
	assert.equal(h.container.children.length, 1, "reconnect does not replay completion");
	await h.load(1, [request("b", "queued")]);
	assert.equal(title(b), "Working", "stale snapshot ignored");
});

test("completion waits for visible refresh while queued requests appear immediately", async () => {
	const h = setup();
	await h.load(0, [request("a", "working")]);
	let finish!: () => void;
	h.setRefresh(() => new Promise(resolve => { finish = resolve; }));
	const loading = h.load(1, [request("a", "completed"), request("b", "queued")]);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(title(h.container.children[0]), "Working");
	assert.equal(title(h.container.children[1]), "Request queued");
	assert.equal(h.timers.size, 0);
	finish();
	await loading;
	assert.equal(title(h.container.children[0]), "Request completed");
	assert.equal([...h.timers.values()][0].ms, 1000);
});

test("failed refresh never announces success and a later snapshot retries", async () => {
	const h = setup();
	await h.load(0, [request("a", "working")]);
	h.setRefresh(async () => { throw new Error("iframe failed"); });
	await h.load(1, [request("a", "completed")]);
	assert.equal(title(h.container.children[0]), "Working");
	assert.equal(h.errors.length, 1);
	assert.equal(h.timers.size, 0);
	h.setRefresh(async () => {});
	await h.load(1, [request("a", "completed")]);
	assert.equal(title(h.container.children[0]), "Request completed");
});

test("retry cancels failure dismissal and text is not injected as HTML", async () => {
	const h = setup();
	await h.load(0, []);
	await h.load(1, [request("a", "failed")]);
	assert.equal([...h.timers.values()][0].ms, 5000);
	await h.load(2, [{ ...request("a", "working"), body: "<script>untrusted</script>" }]);
	assert.equal(h.timers.size, 0);
	assert.equal(h.container.children[0].children[1].children[1].textContent, "<script>untrusted</script>");
});

test("toasts slide left on creation and slide up before removal, not on status updates", async () => {
	const h = setup({ motion: true });
	await h.load(0, [request("a", "queued")]);
	assert.equal(h.animations.length, 1);
	assert.equal(h.animations[0].frames[0].transform, "translateX(32px)");
	assert.equal(h.animations[0].frames[1].transform, "translateX(0)");
	await h.load(1, [request("a", "working")]);
	await h.load(2, [request("a", "completed")]);
	assert.equal(h.animations.length, 1, "pickup/completion do not replay entrance");
	[...h.timers.values()][0].fn();
	assert.equal(h.animations[1].frames[1].transform, "translateY(-20px)");
	assert.equal(h.container.children.length, 1, "retain DOM until exit finishes");
	h.animations[1].finish();
	await Promise.resolve();
	assert.equal(h.container.children.length, 0);
});

test("a retry during slide-up cancels removal and keeps the card", async () => {
	const h = setup({ motion: true });
	await h.load(0, []);
	await h.load(1, [request("a", "failed")]);
	[...h.timers.values()][0].fn();
	await h.load(2, [request("a", "working")]);
	assert.equal(h.animations[1].cancelled, true);
	h.animations[1].finish();
	await Promise.resolve();
	assert.equal(h.container.children.length, 1);
	assert.equal(title(h.container.children[0]), "Working");
});

test("reduced motion skips both entrance and exit animations", async () => {
	const h = setup({ motion: true, reduced: true });
	await h.load(0, [request("a", "working")]);
	await h.load(1, [request("a", "completed")]);
	[...h.timers.values()][0].fn();
	assert.equal(h.animations.length, 0);
	assert.equal(h.container.children.length, 0);
});
