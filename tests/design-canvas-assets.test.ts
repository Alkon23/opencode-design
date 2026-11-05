import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The canvas scripts run in the browser; these tests evaluate them in a minimal
// fake DOM so the focus-mode message contract is checked without a browser.

const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));
const read = (name: string) => readFileSync(join(ASSET_DIR, name), "utf8");

type Listener = (event: any) => void;
// postMessage clones its message; the copy also leaves the vm realm's prototypes behind.
const structuredCopy = (message: unknown) => JSON.parse(JSON.stringify(message));
type Rect = { left: number; top: number; width: number; height: number };

class FakeElement {
	localName: string;
	id = "";
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners = new Map<string, Listener[]>();
	style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
	dataset: Record<string, string> = {};
	textContent = "";
	title = "";
	hidden = false;
	disabled = false;
	inert = false;
	value = "";
	// Set by the canvas on iframes, the Open in new tab link and the Scale to fit checkbox.
	src = "";
	href = "";
	checked = false;
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	contentWindow: { posted: any[]; postMessage(message: any): void } | null = null;
	doc: FakeDocument;

	constructor(tag: string, doc: FakeDocument) {
		this.localName = tag;
		this.doc = doc;
		if (tag === "iframe") {
			const posted: any[] = [];
			this.contentWindow = { posted, postMessage: (message) => posted.push(structuredCopy(message)) };
		}
	}

	get className() { return [...this.classes].join(" "); }
	set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
	get classList() {
		const classes = this.classes;
		return {
			add: (name: string) => classes.add(name),
			remove: (name: string) => classes.delete(name),
			contains: (name: string) => classes.has(name),
			toggle: (name: string, force?: boolean) => {
				const on = force === undefined ? !classes.has(name) : force;
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
		};
	}

	// Layout offsets inside the offset parent; unlike rects, the world's transform never changes them.
	offsetLeft = 0;
	offsetTop = 0;
	get offsetWidth() { return 0; }
	get offsetHeight() { return 0; }
	setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
	getAttribute(name: string) { return this.attributes.get(name) ?? null; }
	hasAttribute(name: string) { return this.attributes.has(name); }
	removeAttribute(name: string) { this.attributes.delete(name); }
	append(...nodes: FakeElement[]) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: FakeElement[]) {
		for (const child of this.children) child.parentElement = null;
		this.children = [];
		this.append(...nodes);
	}
	contains(node: FakeElement | null) {
		for (let current = node; current; current = current.parentElement) if (current === this) return true;
		return false;
	}
	matches(selector: string) {
		return selector.startsWith(".") ? this.classes.has(selector.slice(1)) : this.localName === selector;
	}
	closest(selector: string) {
		for (let current: FakeElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
		return null;
	}
	querySelector() { return null; }
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** Bubbles from this element through its ancestors, like a DOM event. */
	dispatch(type: string, init: Record<string, unknown> = {}) {
		const event: any = { type, target: this, defaultPrevented: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
		for (let current: FakeElement | null = this; current; current = current.parentElement) {
			for (const listener of current.listeners.get(type) ?? []) listener(event);
		}
		return event;
	}
	focus() { this.doc.activeElement = this; }
	getBoundingClientRect() { return this.rect; }
	remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
	setPointerCapture() {}
	showModal() { this.setAttribute("open", ""); }
	close() { this.removeAttribute("open"); }
	scrollIntoView() {}
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	body: FakeElement;
	documentElement: FakeElement;
	title = "";
	byId = new Map<string, FakeElement>();
	listeners = new Map<string, Listener[]>();

	constructor() {
		this.documentElement = new FakeElement("html", this);
		this.body = new FakeElement("body", this);
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}
	createElement(tag: string) { return new FakeElement(tag, this); }
	getElementById(id: string) {
		let element = this.byId.get(id);
		if (!element) {
			element = new FakeElement(id === "gd-back" ? "button" : "div", this);
			element.id = id;
			this.byId.set(id, element);
		}
		return element;
	}
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	querySelectorAll() { return []; }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadCanvas(firstHeight = 300, extraReplies: Record<string, unknown> = {}) {
	const document = new FakeDocument();
	document.getElementById("gd-config").textContent = JSON.stringify({ base: "/t/", slug: "alpha" });
	const viewport = document.getElementById("gd-viewport");
	const world = document.getElementById("gd-world");
	viewport.append(world);
	viewport.rect = { left: 0, top: 50, width: 1000, height: 700 };
	const windowListeners = new Map<string, Listener[]>();
	const replies: Record<string, unknown> = {
		"/t/api/system": { exists: false },
		"/t/api/designs": { designs: [{ slug: "alpha", title: "Alpha", valid: true }] },
		"/t/api/designs/alpha": {
			slug: "alpha",
			title: "Alpha",
			brief: "",
			artboards: [
				{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: firstHeight },
				{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
			],
		},
		"/t/api/designs/alpha/comments": { comments: [] },
		"/t/api/designs/alpha/handoffs": { version: 1, chosen: null, handoffs: {} },
		"/t/api/designs/beta": {
			slug: "beta",
			title: "Beta",
			brief: "",
			artboards: [{ file: "01-only.html", title: "Only", tradeoff: "", width: 500, height: 400 }],
		},
		"/t/api/designs/beta/comments": { comments: [] },
		"/t/api/designs/beta/handoffs": { version: 1, chosen: null, handoffs: {} },
		...extraReplies,
	};
	const fetched: string[] = [];
	const posts: Array<{ url: string; body: unknown }> = [];
	const urls: string[] = [];
	const sourceListeners = new Map<string, Listener[]>();
	const context: Record<string, any> = {
		document,
		console,
		// Canvas timers (toasts, the preview load timeout) must not keep the test process alive.
		setTimeout: (callback: () => void, ms?: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
		clearTimeout,
		location: { port: "4100", origin: "http://127.0.0.1:4100" },
		URL,
		innerWidth: 1200,
		innerHeight: 800,
		CSS: { escape: (value: string) => value },
		history: { replaceState(_state: unknown, _title: string, url: string) { urls.push(url); } },
		localStorage: { getItem: () => null, setItem() {} },
		requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
		fetch: async (url: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "null") });
			fetched.push(url);
			return { ok: url in replies, status: url in replies ? (url === "/t/api/comments" && init?.method === "POST" ? (JSON.parse(init.body ?? "{}").mode === "collect" ? 201 : 202) : 200) : 404, json: async () => replies[url] ?? {} };
		},
		EventSource: class {
			addEventListener(type: string, listener: Listener) {
				sourceListeners.set(type, [...(sourceListeners.get(type) ?? []), listener]);
			}
		},
		addEventListener(type: string, listener: Listener) {
			windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
		},
	};
	context.window = context;
	vm.runInNewContext(read("canvas.js"), context);
	for (let i = 0; i < 10; i++) await flush();
	const boards = withClass(world, "gd-artboard").map((wrapper) => {
		const box = wrapper.children.find((child) => child.classes.has("gd-frame-box"))!;
		const frame = box.children.find((child) => child.localName === "iframe")!;
		const shield = box.children.find((child) => child.classes.has("gd-shield"));
		return { wrapper, frame, shield };
	});
	const message = (source: unknown, data: unknown) => {
		for (const listener of windowListeners.get("message") ?? []) listener({ source, data });
	};
	const windowEvent = (type: string) => {
		for (const listener of windowListeners.get(type) ?? []) listener({ type });
	};
	/** A server-sent event on the canvas's live-reload stream, then the async work it starts. */
	const serverEvent = async (type: string, data: unknown) => {
		for (const listener of sourceListeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) });
		for (let i = 0; i < 10; i++) await flush();
	};
	const frames = () => withClass(world, "gd-artboard").map((wrapper) => wrapper.children.find((child) => child.classes.has("gd-frame-box"))!.children.find((child) => child.localName === "iframe")!);
	return { document, viewport, world, boards, message, windowEvent, serverEvent, frames, fetched, posts, urls, replies, zoomLevel: document.getElementById("gd-zoom-level"), navMode: document.getElementById("gd-nav-mode") };
}

function click(target: FakeElement, x: number, y: number) {
	target.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: x, clientY: y });
	target.dispatch("pointerup", { button: 0, pointerId: 1, clientX: x, clientY: y });
}

test("system board comments and standalone feedback use system-only payloads and scoped sidebar routes", async () => {
	const canvas = await loadCanvas(300, {
		"/t/api/system": { exists: true, file: "system.html", width: 1440, height: 900 },
		"/t/api/system/comments": { comments: [{ id: "sameid", scope: "system", comment: "Blue", status: "open", sentAt: null, screenshot: ".system-screenshots/sameid.png" }] },
		"/t/api/comments": { ok: true },
		"/t/api/system/comments/send-all": { sent: 1 },
	});
	const get = (id: string) => canvas.document.getElementById(id);
	assert.equal(get("gd-system-comment").disabled, false);
	get("gd-system-comment").dispatch("click");
	assert.equal(get("gd-comment-scope").value, "system");
	get("gd-popover-text").value = "Change palette";
	get("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[0].body, { scope: "system", comment: "Change palette", mode: "collect" });
	assert.equal(get("gd-feedback-scope").value, "system");
	const shot = withClass(get("gd-comment-list"), "gd-comment-shot")[0];
	assert.equal(shot.src, "/t/api/system/comments/sameid/screenshot");
	get("gd-send-all").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(canvas.posts[1].url, "/t/api/system/comments/send-all");
	get("gd-popover-cancel").dispatch("click");
	get("gd-comment").dispatch("click");
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pick", selector: "h2", excerpt: "Colors", rect: { x: 0, y: 0, width: 20, height: 20 } });
	assert.equal(get("gd-comment-scope").value, "system");
	get("gd-popover-text").value = "Change this color";
	get("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[2].body, { scope: "system", selector: "h2", excerpt: "Colors", comment: "Change this color", mode: "collect" });
	await canvas.serverEvent("show", { slug: null });
	assert.equal(get("gd-system-comment").disabled, false);
	assert.equal(get("gd-general-comment").disabled, true);
	get("gd-system-comment").dispatch("click");
	get("gd-popover-text").value = "System-only feedback";
	get("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[3].body, { scope: "system", comment: "System-only feedback", mode: "collect" });
});

test("comments always collect until Send feedback explicitly submits the batch", async () => {
	assert.doesNotMatch(read("index.html"), /gd-mode-send|gd-mode-collect|Send now/);
	const canvas = await loadCanvas(300, {
		"/t/api/comments": { ok: true },
		"/t/api/designs/alpha/comments/send-all": { sent: 2 },
	});
	const get = (id: string) => canvas.document.getElementById(id);
	assert.equal(get("gd-popover-send").textContent, "Save");
	for (const comment of ["First suggestion", "Second suggestion"]) {
		get("gd-general-comment").dispatch("click");
		get("gd-popover-text").value = comment;
		get("gd-popover-form").dispatch("submit");
		for (let i = 0; i < 5; i++) await flush();
		get("gd-popover-cancel").dispatch("click");
	}
	assert.equal(canvas.posts.length, 2);
	assert.ok(canvas.posts.every(post => post.url === "/t/api/comments" && (post.body as any).mode === "collect"));
	assert.match(get("gd-status").textContent, /Saved; click Send feedback/);
	get("gd-send-all").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[2], { url: "/t/api/designs/alpha/comments/send-all", body: {} });
});

test("General comment opens without selecting an element and saves design-wide feedback", async () => {
	const canvas = await loadCanvas(300, { "/t/api/comments": { ok: true, id: "general1" } });
	const get = (id: string) => canvas.document.getElementById(id);
	get("gd-popover").append(get("gd-popover-text"));
	assert.equal(get("gd-general-comment").disabled, false);
	get("gd-general-comment").dispatch("click");
	assert.equal(get("gd-popover").hidden, false);
	assert.equal(get("gd-comment-scope").value, "general");
	assert.equal(get("gd-scope-element").disabled, true);
	assert.equal(get("gd-popover-target").textContent, "All proposals in this design");
	get("gd-popover-text").value = "Add testimonials to all proposals";
	get("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[0], { url: "/t/api/comments", body: {
		slug: "alpha", scope: "general", comment: "Add testimonials to all proposals", mode: "collect",
	} });
	get("gd-popover-cancel").dispatch("click");
	assert.equal(canvas.document.activeElement?.id, "gd-general-comment");
});

test("element composer can switch to general scope and back without losing its draft", async () => {
	const canvas = await loadCanvas(300, { "/t/api/comments": { ok: true } });
	const get = (id: string) => canvas.document.getElementById(id);
	get("gd-comment").dispatch("click");
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pick", selector: "#hero", excerpt: "Hello", rect: { x: 10, y: 10, width: 100, height: 20 } });
	assert.equal(get("gd-comment-scope").value, "element");
	assert.equal(get("gd-scope-element").disabled, false);
	get("gd-popover-text").value = "A retained draft";
	get("gd-comment-scope").value = "general";
	get("gd-comment-scope").dispatch("change");
	assert.equal(get("gd-popover-target").textContent, "All proposals in this design");
	assert.equal(get("gd-popover-text").value, "A retained draft");
	get("gd-comment-scope").value = "element";
	get("gd-comment-scope").dispatch("change");
	assert.match(get("gd-popover-target").textContent, /01-a.html.*#hero/);
	get("gd-comment-scope").value = "general";
	get("gd-comment-scope").dispatch("change");
	get("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[0].body, { slug: "alpha", scope: "general", comment: "A retained draft", mode: "collect" });
});

test("general comments appear as All proposals without pins, detached badges, or artboard navigation", async () => {
	const shared = { comment: "Add a footer", status: "open", sentAt: null, createdAt: "2026-11-03T10:00:00Z", resolvedAt: null };
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/comments": { comments: [
		{ ...shared, id: "general1", scope: "general" },
		{ ...shared, id: "element1", file: "01-a.html", selector: "#hero", excerpt: "Hello" },
	] } });
	const list = canvas.document.getElementById("gd-comment-list");
	const general = list.children[0];
	assert.match(withClass(general, "gd-comment-meta")[0].children.map((c) => c.textContent).join(" "), /All proposals/);
	assert.deepEqual(withClass(general, "gd-badge-detached"), []);
	canvas.boards[0].frame.dispatch("load");
	const pinMessages = canvas.boards[0].frame.contentWindow!.posted.filter((p) => p.type === "gd:pins");
	assert.deepEqual(pinMessages.at(-1).pins, [{ id: "element1", selector: "#hero" }]);
	const before = canvas.world.style.transform;
	withClass(general, "gd-comment-show")[0].dispatch("click");
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.boards[0].frame.contentWindow!.posted.some((p) => p.type === "gd:highlight"), false);
	assert.equal(canvas.document.getElementById("gd-send-all").textContent, "Send feedback (2)");
});

test("changing designs closes a general draft and system-only views disable general comments", async () => {
	const canvas = await loadCanvas();
	const get = (id: string) => canvas.document.getElementById(id);
	get("gd-general-comment").dispatch("click");
	get("gd-popover-text").value = "Do not send to another design";
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(get("gd-popover").hidden, true);
	get("gd-popover-form").dispatch("submit");
	assert.deepEqual(canvas.posts, []);
	await canvas.serverEvent("show", { slug: null });
	assert.equal(get("gd-general-comment").disabled, true);
	get("gd-general-comment").dispatch("click");
	assert.equal(get("gd-popover").hidden, true);
});

test("a click on an artboard's shield enters focus mode at 100% and only that artboard can end it", async () => {
	const canvas = await loadCanvas();
	assert.equal(canvas.boards.length, 2);
	const [first, second] = canvas.boards;
	assert.ok(first.shield && second.shield, "every artboard has an interaction shield");
	assert.equal(canvas.navMode.textContent, "Navigating");

	// Start from a non-default view so restoring it is observable.
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	canvas.viewport.dispatch("wheel", { deltaX: 30, deltaY: 20, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const before = canvas.world.style.transform;
	const zoomBefore = canvas.zoomLevel.textContent;
	assert.notEqual(zoomBefore, "100%");

	first.frame.rect = { left: 120, top: 140, width: 268, height: 201 };
	click(first.shield!, 200, 200);
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.match(canvas.world.style.transform, /scale\(1\)$/);
	assert.equal(first.shield!.hidden, true, "the focused artboard loses its shield");
	assert.equal(second.shield!.hidden, false);
	assert.equal(second.wrapper.inert, true, "the other artboards are inert");
	assert.equal(canvas.document.activeElement, first.frame, "keyboard focus moves into the artboard");
	assert.match(canvas.navMode.textContent, /^Using: First · Shift\+Esc to exit$/);
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:focus", enabled: true });

	// Canvas pan and zoom are off while focused.
	const focusedTransform = canvas.world.style.transform;
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 10, clientY: 10 });
	canvas.message(first.frame.contentWindow, { type: "gd:wheel", deltaX: 0, deltaY: 80, deltaMode: 0, zoom: true, shift: false, x: 5, y: 5 });
	assert.equal(canvas.world.style.transform, focusedTransform);

	// gd:exit-focus is accepted only from the focused artboard's own window.
	canvas.message(second.frame.contentWindow, { type: "gd:exit-focus" });
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(canvas.zoomLevel.textContent, "100%");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(canvas.world.style.transform, before, "the previous zoom and pan return exactly");
	assert.equal(canvas.zoomLevel.textContent, zoomBefore);
	assert.equal(first.shield!.hidden, false);
	assert.equal(second.wrapper.inert, false);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("a taller artboard is top-aligned and clipped to the viewport while focused, then restored", async () => {
	const canvas = await loadCanvas(1600);
	const [first] = canvas.boards;
	assert.equal(first.frame.style.height, "1600px");
	// In world coordinates the frame box sits at (480, 20), under a 20 px label.
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	click(first.shield!, 200, 200);
	// The 700 px viewport keeps a 16 px margin, the 20 px label and a 64 px band for the Back button.
	assert.equal(first.frame.style.height, "600px");
	// x centers the 400 px board in 1000 px: 300 - 480; y puts its top 16 + 20 px down: 36 - 20.
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	// Re-centering (window resize, panel toggle) is idempotent.
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(first.frame.style.height, "1600px");
});

test("entering focus hides an open panel and exiting restores it; a closed panel stays closed", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const panel = canvas.document.getElementById("gd-panel");
	const toggle = canvas.document.getElementById("gd-panel-toggle");
	assert.equal(panel.hidden, false);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true, "focus mode hides the open panel to gain width");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(panel.hidden, false, "exiting reopens it");
	assert.equal(toggle.getAttribute("aria-pressed"), "true");

	toggle.dispatch("click");
	assert.equal(panel.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(panel.hidden, true, "a closed panel stays closed");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("the Back to canvas button and Shift+Esc in the canvas both leave focus mode", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const back = canvas.document.getElementById("gd-back");
	assert.equal(back.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(back.hidden, false);
	back.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(back.hidden, true);

	click(first.shield!, 200, 200);
	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const plain: any = { key: "Escape", shiftKey: false, target: back, defaultPrevented: false, preventDefault() { plain.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(plain));
	assert.match(canvas.navMode.textContent, /^Using:/, "plain Esc does not leave focus mode");
	const chord: any = { key: "Escape", shiftKey: true, target: back, defaultPrevented: false, preventDefault() { chord.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(chord));
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("discard control requires confirmation and sends only its own proposal target", async () => {
	const canvas = await loadCanvas();
	const start = withClass(canvas.boards[0].wrapper, "gd-discard-start")[0];
	const confirm = canvas.document.getElementById("gd-discard-dialog");
	const cancel = canvas.document.getElementById("gd-discard-cancel");
	start.dispatch("click");
	assert.equal(confirm.hidden, false); assert.equal(canvas.posts.length, 0);
	assert.equal(confirm.hasAttribute("open"), true);
	assert.ok(canvas.document.activeElement === cancel, "safe action receives focus");
	assert.equal(withClass(canvas.world, "gd-discard-confirm").length, 0, "confirmation is outside scaled proposal controls");
	cancel.dispatch("click"); assert.equal(confirm.hidden, true);
	assert.ok(canvas.document.activeElement === start, "Cancel returns focus to trigger");
	start.dispatch("click"); confirm.dispatch("keydown", { key: "Escape" });
	assert.equal(confirm.hidden, true); assert.equal(canvas.posts.length, 0);
	start.dispatch("click"); canvas.document.getElementById("gd-discard-confirm").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts[0], { url: "/t/api/designs/alpha/discard", body: { file: "01-a.html" } });
	assert.match(read("index.html"), /<dialog id="gd-discard-dialog"/);
});

test("multi-page selection chooses one alternative per page and submits together", async () => {
	const alpha = { slug: "alpha", title: "Home", artboards: [1, 2].map(i => ({ file: `${i}.html`, title: `Home ${i}`, width: 400, height: 300 })) };
	const beta = { slug: "beta", title: "Pricing", parent: { slug: "alpha", file: "1.html" }, artboards: [{ file: "price.html", title: "Price", width: 400, height: 300 }] };
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha": alpha, "/t/api/designs/alpha/family": { designs: [alpha, beta], warnings: [] }, "/t/api/implement": { queued: true } });
	const choices = withClass(canvas.world, "gd-implementation-choice").map(label => label.children[0]);
	choices[0].checked = true; choices[0].dispatch("change");
	choices[1].checked = true; choices[1].dispatch("change");
	assert.equal(choices[0].checked, false, "only one alternative per page");
	choices[2].checked = true; choices[2].dispatch("change");
	assert.equal(canvas.document.getElementById("gd-implement-selected").textContent, "Implement selected (2)");
	const down = choices[1].dispatch("pointerdown", { button: 0, pointerId: 1 });
	assert.equal(down.defaultPrevented, false, "selection controls do not start canvas panning");
	canvas.document.getElementById("gd-implement-selected").dispatch("click");
	for (let i = 0; i < 10; i++) await flush();
	assert.deepEqual(canvas.posts[0], { url: "/t/api/implement", body: { targets: [{ slug: "alpha", file: "2.html" }, { slug: "beta", file: "price.html" }] } });
	assert.equal(canvas.document.getElementById("gd-implement-selected").disabled, true);
});

test("floating plus uses a centered geometric icon rather than a font baseline", () => {
	const css = read("canvas.css");
	const button = css.match(/\.gd-new-page\s*\{([^}]+)\}/)![1];
	assert.match(button, /display:\s*grid/);
	assert.match(button, /place-items:\s*center/);
	assert.match(button, /padding:\s*0/);
	assert.match(button, /font-size:\s*0/);
	const icon = css.match(/\.gd-new-page::before\s*\{([^}]+)\}/)![1];
	assert.match(icon, /position:\s*absolute/);
	assert.match(icon, /left:\s*50%/);
	assert.match(icon, /top:\s*50%/);
	assert.match(icon, /transform:\s*translate\(-50%,\s*-50%\)/);
});

test("new page action opens a reference-bound brief dialog and retains request identity on retry", async () => {
	const canvas = await loadCanvas();
	const button = withClass(canvas.boards[0].wrapper, "gd-new-page")[0];
	assert.ok(button, "proposal has a keyboard-accessible floating plus");
	button.dispatch("click");
	const get = (id: string) => canvas.document.getElementById(id);
	assert.equal(get("gd-page-dialog").hidden, false);
	assert.match(get("gd-page-reference").textContent, /alpha.*01-a.html/);
	get("gd-page-brief").value = "Pricing page with annual plans";
	get("gd-page-count").value = "4";
	get("gd-page-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	get("gd-page-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(canvas.posts.length, 2);
	assert.deepEqual(canvas.posts[0], canvas.posts[1], "failed request retry is identical");
	assert.equal(canvas.posts[0].url, "/t/api/designs/alpha/pages");
	assert.equal((canvas.posts[0].body as any).file, "01-a.html");
	assert.equal((canvas.posts[0].body as any).count, 4);
});

test("related page proposals render together with parent edges and resize together", async () => {
	const parent = { slug: "alpha", title: "Home", brief: "", artboards: [{ file: "01-a.html", title: "Home A", width: 400, height: 300 }] };
	const child = { slug: "pricing", title: "Pricing", brief: "", parent: { slug: "alpha", file: "01-a.html" }, artboards: [1,2,3].map((i) => ({ file: `0${i}-a.html`, title: `Pricing ${i}`, width: 400, height: 300 })) };
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha": parent, "/t/api/designs/alpha/family": { designs: [parent, child], warnings: [] } });
	assert.equal(canvas.frames().length, 4);
	assert.equal(withClass(canvas.world, "gd-panel-connection").length, 1);
	assert.match(canvas.frames()[1].src, /files\/pricing\//);
	canvas.document.getElementById("gd-device-mobile").dispatch("click");
	for (const frame of canvas.frames()) assert.equal(frame.style.width, "390px");
	assert.ok(Number.parseFloat(canvas.world.children[1].style.top) > Number.parseFloat(canvas.world.children[0].style.top));
	const childBoard = canvas.world.children[1];
	const shield = withClass(childBoard, "gd-shield")[0];
	click(shield, 10, 10);
	assert.equal(canvas.document.getElementById("gd-design").value, "alpha", "entering a child changes feedback scope without rerooting the canvas");
	assert.match(canvas.fetched.at(-1)!, /pricing/);
	const parentFrame = canvas.frames()[0];
	parentFrame.dispatch("load");
	assert.deepEqual(parentFrame.contentWindow!.posted.filter((p) => p.type === "gd:pins").at(-1).pins, [], "same filename from child cannot leak pins onto parent");
});

test("page panels collapse whole subtrees and retain nested state across refresh", async () => {
	const design = (slug: string, parent?: { slug: string; file: string }) => ({ slug, title: slug, parent, artboards: [1, 2].map(i => ({ file: `${i}.html`, title: `${slug} ${i}`, width: 400, height: 300 })) });
	const alpha = design("alpha"), child = design("child", { slug: "alpha", file: "1.html" }), grandchild = design("grandchild", { slug: "child", file: "2.html" });
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha": alpha, "/t/api/designs/alpha/family": { designs: [alpha, child, grandchild] } });
	const panels = () => withClass(canvas.world, "gd-page-panel");
	const panel = (slug: string) => panels().find(p => p.dataset.slug === slug)!;
	const toggle = (slug: string) => withClass(withClass(canvas.world, "gd-panel-connection").find(edge => edge.dataset.child === slug)!, "gd-panel-toggle")[0];
	assert.equal(panels().length, 3, "one container per page, not per alternative");
	assert.equal(withClass(panel("alpha"), "gd-panel-toggle").length, 0, "selected root cannot collapse");
	assert.equal(withClass(canvas.world, "gd-panel-connection").length, 2, "one connection per child panel");
	const childEdge = withClass(canvas.world, "gd-panel-connection").find(edge => edge.dataset.child === "child")!;
	assert.equal(withClass(childEdge, "gd-panel-toggle").length, 1, "child collapse control sits on the parent-side start of its connector");
	assert.equal(toggle("child").style.top, `${parseFloat(panel("alpha").style.top) + 504}px`, "collapse control aligns with the connector start at the parent panel edge");
	assert.equal(parseFloat(toggle("child").style.left), parseFloat(withClass(childEdge, "gd-parent-route")[0].style.left) - 38, "collapse control is offset from the child-page button at the connector start");
	toggle("grandchild").dispatch("click");
	assert.equal(toggle("grandchild").textContent, "+");
	toggle("child").dispatch("click");
	assert.equal(panel("grandchild").hidden, true);
	assert.equal(withClass(panel("child"), "gd-panel-body")[0].hidden, true);
	assert.equal(toggle("child").getAttribute("aria-expanded"), "false");
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal(panel("grandchild").hidden, true, "ancestor collapse survives manifest refresh");
	toggle("child").dispatch("click");
	assert.equal(panel("grandchild").hidden, false);
	assert.equal(toggle("grandchild").textContent, "+", "descendant retains its own collapsed state");
	assert.equal(withClass(panel("grandchild"), "gd-panel-body")[0].hidden, true);
});

test("child selection shows system, exact reference and selected subtree only", async () => {
	const design = (slug: string, parent?: { slug: string; file: string }) => ({ slug, title: slug, parent, artboards: [1, 2].map(i => ({ file: `${i}.html`, title: `${slug} ${i}`, width: 400, height: 300 })) });
	const alpha = design("alpha"), child = design("child", { slug: "alpha", file: "2.html" }), other = design("other", { slug: "alpha", file: "1.html" }), grandchild = design("grandchild", { slug: "child", file: "1.html" });
	const family = { designs: [alpha, child, other, grandchild] };
	const canvas = await loadCanvas(300, {
		"/t/api/system": { exists: true, file: "system.html", width: 1440, height: 900 },
		"/t/api/designs": { designs: [alpha, child, other, grandchild].map(d => ({ ...d, valid: true })) },
		"/t/api/designs/alpha": alpha, "/t/api/designs/alpha/family": family,
		"/t/api/designs/child": child, "/t/api/designs/child/family": family,
	});
	const selector = canvas.document.getElementById("gd-design");
	const options = findAll(selector, e => e.localName === "option");
	assert.match(options.find(o => o.value === "alpha")!.textContent, /Initial/);
	assert.match(options.find(o => o.value === "child")!.textContent, /Child.*alpha.*2.html/);
	selector.value = "child"; selector.dispatch("change");
	for (let i = 0; i < 10; i++) await flush();
	const sources = canvas.frames().map(f => f.src.replace(/\?v=.*$/, ""));
	assert.ok(sources.some(s => s.endsWith("system.html")));
	assert.equal(sources.filter(s => s.includes("files/alpha/")).length, 1);
	assert.ok(sources.some(s => s.endsWith("files/alpha/2.html")));
	assert.ok(!sources.some(s => s.includes("files/other/")));
	assert.equal(withClass(canvas.world, "gd-page-panel").length, 2);
	assert.equal(withClass(canvas.world, "gd-parent-reference").length, 1);
	assert.equal(withClass(canvas.world, "gd-panel-toggle").length, 1, "only descendant panel can collapse");
});

test("cyclic references keep the selected proposals visible", async () => {
	const design = (slug: string, parent: { slug: string; file: string }) => ({
		slug, title: slug, brief: "", parent,
		artboards: [1, 2].map(i => ({ file: `${i}.html`, title: `${slug} ${i}`, width: 400, height: 300 })),
	});
	const alpha = design("alpha", { slug: "beta", file: "1.html" });
	const beta = design("beta", { slug: "alpha", file: "2.html" });
	const canvas = await loadCanvas(300, {
		"/t/api/designs/alpha": alpha,
		"/t/api/designs/alpha/family": {
			designs: [{ ...beta, artboards: [beta.artboards[0]] }, alpha],
			warnings: ["Missing or cyclic reference: showing available proposals only."],
		},
	});
	const selected = canvas.boards.filter(board => board.frame.src.includes("/files/alpha/"));
	assert.equal(selected.length, 2);
	for (const board of selected) {
		for (let node: FakeElement | null = board.wrapper; node; node = node.parentElement) {
			assert.equal(node.hidden, false, `selected proposal hidden by ${node.className}`);
		}
	}
});

test("family branches use vertical space without widening original proposal gaps", async () => {
	const artboard = (file: string) => ({ file, title: file, width: 400, height: 300 });
	const parent = { slug: "alpha", title: "Home", artboards: [artboard("01-a.html"), artboard("02-b.html")] };
	const children = ["pricing", "about"].map((slug, index) => ({ slug, title: slug, parent: { slug: "alpha", file: parent.artboards[index].file }, artboards: [1, 2, 3].map((i) => artboard(`${i}.html`)) }));
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha": parent, "/t/api/designs/alpha/family": { designs: [parent, ...children], warnings: [] } });
	const nodes = withClass(canvas.world, "gd-page-panel");
	assert.equal(withClass(nodes[0], "gd-artboard").length, 2, "root alternatives share one panel");
	assert.ok(parseFloat(nodes[1].style.top) >= 700, "child group has a generous vertical gap");
	assert.ok(parseFloat(nodes[2].style.top) > parseFloat(nodes[1].style.top) + 400, "separate branches occupy separate vertical rows");
	assert.equal(withClass(canvas.world, "gd-panel-connection").length, 2);
	const routes = withClass(canvas.world, "gd-parent-route");
	for (const route of routes) {
		const x = parseFloat(route.style.left);
		const y = parseFloat(route.style.top);
		const width = parseFloat(route.style.width);
		const height = parseFloat(route.style.height);
		for (const node of nodes) {
			const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
			const panelWidth = parseFloat(node.style.width), panelHeight = 504;
			const intersects = width === 0
				? x > left && x < left + panelWidth && y < top + panelHeight && y + height > top
				: y > top && y < top + panelHeight && x < left + panelWidth && x + width > left;
			assert.equal(intersects, false, "connector routes never cross proposal rectangles");
		}
	}
});

test("child Compare restores focus by slug and file", async () => {
	const design = (slug: string) => ({ slug, title: slug, brief: "", artboards: [{ file: "same.html", title: slug, tradeoff: "", width: 400, height: 300 }] });
	const alpha = design("alpha");
	const beta = { ...design("beta"), parent: { slug: "alpha", file: "same.html" } };
	const handoffs = { version: 1, chosen: "same.html", handoffs: { "same.html": { status: "implemented", previewUrl: "http://127.0.0.1:9999/", sentAt: null, startedAt: null, implementedAt: "2026-01-01" } } };
	const canvas = await loadCanvas(300, {
		"/t/api/designs/alpha": alpha,
		"/t/api/designs/alpha/family": { designs: [alpha, beta], warnings: [] },
		"/t/api/designs/alpha/handoffs": handoffs,
		"/t/api/designs/beta/handoffs": handoffs,
	});
	const buttons = withClass(canvas.world, "gd-compare-start");
	assert.equal(buttons.length, 2);
	buttons[1].dispatch("click");
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.ok(canvas.document.activeElement === buttons[1]);
});

test("device toolbar uses three accessible icon buttons with desktop selected initially", () => {
	const html = read("index.html");
	assert.doesNotMatch(html, /<select[^>]*id="gd-device"/);
	for (const device of ["mobile", "tablet", "desktop"]) {
		const button = html.match(new RegExp(`<button[^>]*id="gd-device-${device}"[\\s\\S]*?</button>`))![0];
		assert.match(button, /aria-label="(?:Mobile|Tablet|Desktop)"/);
		assert.match(button, new RegExp(`aria-pressed="${device === "desktop"}"`));
		assert.match(button, /<svg[^>]*aria-hidden="true"/);
	}
});

test("device buttons resize every proposal viewport and restore original desktop dimensions", async () => {
	const canvas = await loadCanvas(500, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 900 } });
	const device = (name: string) => canvas.document.getElementById(`gd-device-${name}`);
	device("mobile").dispatch("click");
	assert.equal(device("mobile").getAttribute("aria-pressed"), "true");
	assert.equal(device("tablet").getAttribute("aria-pressed"), "false");
	assert.equal(device("desktop").getAttribute("aria-pressed"), "false");
	assert.equal(canvas.boards[0].frame.style.width, "1440px", "system board is unchanged");
	for (const board of canvas.boards.slice(1)) {
		assert.equal(board.frame.style.width, "390px");
		assert.equal(board.frame.style.height, "844px");
	}
	device("tablet").dispatch("click");
	assert.equal(device("tablet").getAttribute("aria-pressed"), "true");
	assert.equal(device("mobile").getAttribute("aria-pressed"), "false");
	for (const board of canvas.boards.slice(1)) {
		assert.equal(board.frame.style.width, "768px");
		assert.equal(board.frame.style.height, "1024px");
	}
	device("desktop").dispatch("click");
	assert.equal(device("desktop").getAttribute("aria-pressed"), "true");
	assert.equal(device("tablet").getAttribute("aria-pressed"), "false");
	assert.equal(canvas.boards[1].frame.style.width, "400px");
	assert.equal(canvas.boards[1].frame.style.height, "500px");
	assert.equal(canvas.boards[2].frame.style.height, "300px");
	assert.deepEqual(canvas.posts, [], "device changes never persist manifest edits");
});

test("device choice survives proposal reloads and design switches", async () => {
	const canvas = await loadCanvas();
	canvas.document.getElementById("gd-device-mobile").dispatch("click");
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(canvas.frames()[0].style.width, "390px");
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(canvas.frames()[0].style.width, "390px");
	assert.equal(canvas.frames()[0].style.height, "844px");
});

test("device sizes remain active in focus mode and resize both Compare frames", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/" } }) });
	click(canvas.boards[0].shield!, 10, 10);
	canvas.document.getElementById("gd-device-mobile").dispatch("click");
	assert.equal(canvas.boards[0].frame.style.width, "390px");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(canvas.boards[0].frame.style.height, "844px");
	withClass(canvas.boards[0].wrapper, "gd-compare-start")[0].dispatch("click");
	const panes = canvas.document.getElementById("gd-compare-panes");
	const frames = panes.children.map((pane) => pane.children.find((child) => child.localName === "iframe")!);
	assert.equal(frames[0].style.width, "390px");
	assert.equal(frames[1].style.width, "390px");
	canvas.document.getElementById("gd-device-tablet").dispatch("click");
	for (const frame of frames) {
		assert.equal(frame.style.width, "768px");
		assert.equal(frame.style.height, "1024px");
	}
});

test("pan gestures cancel native selection and clean up on cancellation or lost capture", async () => {
	const canvas = await loadCanvas();
	const down = (target: FakeElement, button = 0) => target.dispatch("pointerdown", { button, pointerId: 1, clientX: 10, clientY: 10 });
	assert.equal(down(canvas.viewport).defaultPrevented, true);
	assert.equal(canvas.viewport.classes.has("gd-panning"), true);
	canvas.viewport.dispatch("lostpointercapture", { pointerId: 1 });
	assert.equal(canvas.viewport.classes.has("gd-panning"), false);
	const before = canvas.world.style.transform;
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 80, clientY: 80 });
	assert.equal(canvas.world.style.transform, before);
	assert.equal(down(canvas.boards[0].shield!).defaultPrevented, true);
	canvas.viewport.dispatch("pointercancel", { pointerId: 1 });
	assert.equal(canvas.viewport.classes.has("gd-panning"), false);
	assert.equal(down(canvas.viewport, 2).defaultPrevented, false);
	const button = canvas.document.createElement("button");
	canvas.viewport.append(button);
	assert.equal(down(button).defaultPrevented, false);
	click(canvas.boards[0].shield!, 10, 10);
	assert.equal(down(canvas.viewport).defaultPrevented, false, "focused views retain native interaction");
	assert.match(read("canvas.css"), /\.gd-viewport:not\(\.gd-focused\)\s*\{[^}]*user-select:\s*none/s);
});

test("a drag over an artboard pans the canvas, and in comment mode a click is routed to the inspector as a pick", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	const before = canvas.world.style.transform;
	first.shield!.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
	first.shield!.dispatch("pointermove", { pointerId: 1, clientX: 190, clientY: 170 });
	first.shield!.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 190, clientY: 170 });
	assert.notEqual(canvas.world.style.transform, before, "the drag panned");
	assert.equal(canvas.navMode.textContent, "Navigating", "a drag never enters focus mode");

	canvas.document.getElementById("gd-comment").dispatch("click");
	click(first.shield!, 150, 130);
	assert.equal(canvas.navMode.textContent, "Navigating", "comment mode picks instead of focusing");
	// The frame shows a 400x300 artboard at half size: (150-100)/0.5, (130-100)/0.5.
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:pick-at", x: 100, y: 60 });
});

// S14: `open` while a canvas page is connected sends it a show event instead of opening a tab.

test("a show event for the same design re-fetches its manifest and reloads its artboards, keeping zoom, pan and focus", async () => {
	const canvas = await loadCanvas();
	// A laid-out world, so a fit() during the refresh would visibly change the view.
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 900 });
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const view = canvas.world.style.transform;
	const zoom = canvas.zoomLevel.textContent;
	const before = canvas.frames();
	const manifestFetches = canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length;
	// A file written while the page missed the change event: the refresh must still pick it up.
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length, manifestFetches + 1, "the manifest is fetched again");
	const after = canvas.frames();
	assert.equal(after.length, 3, "the new artboard appears");
	assert.ok(after.every((frame) => !before.includes(frame)), "every artboard is reloaded");
	assert.equal(canvas.world.style.transform, view, "pan and zoom stay");
	assert.equal(canvas.zoomLevel.textContent, zoom);
	assert.equal(canvas.urls.at(-1), "/t/d/alpha/");

	// Focus mode survives a refresh of the same design, on the same artboard.
	const shield = canvas.frames()[0].parentElement!.children.find((child) => child.classes.has("gd-shield"))!;
	click(shield, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.match(canvas.navMode.textContent, /^Using: First/, "focus stays on the same artboard");
	assert.equal(canvas.zoomLevel.textContent, "100%");
});

test("a show event for another design leaves focus, loads that design and replaces the URL", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	click(first.shield!, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using:/);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.ok(canvas.fetched.includes("/t/api/designs/beta"), "the other design's manifest is loaded");
	assert.ok(canvas.fetched.includes("/t/api/designs/beta/comments"), "and its comments");
	assert.equal(canvas.urls.at(-1), "/t/d/beta/");
	assert.equal(canvas.document.getElementById("gd-title").textContent, "Beta");
	assert.equal(canvas.document.getElementById("gd-design").value, "beta", "the design selector follows");
	assert.equal(canvas.navMode.textContent, "Navigating", "focus mode ends when the design changes");
	assert.deepEqual(canvas.frames().map((frame) => frame.title), ["Only artboard"]);

	await canvas.serverEvent("show", { slug: null });
	assert.equal(canvas.urls.at(-1), "/t/", "null shows the system-only view at the root URL");
	assert.equal(canvas.document.getElementById("gd-title").textContent, "OpenCode Design");
	assert.deepEqual(canvas.frames(), []);

	const fetches = canvas.fetched.length;
	for (const data of [{ slug: 3 }, {}, "beta", { slug: "../x" }]) await canvas.serverEvent("show", data);
	assert.equal(canvas.fetched.length, fetches, "a malformed show event is ignored");
});

function loadInspector() {
	const posted: any[] = [];
	const listeners = new Map<string, Listener[]>();
	class Element {}
	const style = () => ({ cursor: "" });
	const makeNode = () => Object.assign(new Element(), {
		style: style(),
		isConnected: false,
		setAttribute() {},
		hasAttribute: () => false,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
	});
	const button = Object.assign(new Element(), {
		id: "cta",
		localName: "button",
		innerText: "Buy now",
		parentElement: null,
		hasAttribute: () => false,
		getAttribute: () => null,
		getBoundingClientRect: () => ({ left: 4, top: 8, width: 60, height: 20 }),
	});
	const scrolling = { scrollTop: 0, scrollLeft: 0, clientHeight: 100, scrollHeight: 100, clientWidth: 100, scrollWidth: 100, parentElement: null };
	const documentElement = Object.assign(makeNode(), { append() {} });
	const document = {
		documentElement,
		body: makeNode(),
		scrollingElement: scrolling,
		createElement: makeNode,
		elementFromPoint: () => button,
		querySelectorAll: (selector: string) => (selector === "#cta" ? [button] : []),
		querySelector: () => null,
	};
	const parent = { postMessage: (message: any) => posted.push(structuredCopy(message)) };
	const context: Record<string, any> = {
		document,
		Element,
		CSS: { escape: (value: string) => value },
		getComputedStyle: () => ({ overflowX: "hidden", overflowY: "hidden" }),
		requestAnimationFrame: () => 0,
		MutationObserver: class { observe() {} },
		parent,
		addEventListener(type: string, listener: Listener) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
	};
	context.window = context;
	vm.runInNewContext(read("inspector.js"), context);
	const fire = (type: string, init: Record<string, unknown>) => {
		const event: any = { defaultPrevented: false, propagationStopped: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.propagationStopped = true; }, stopImmediatePropagation() { event.propagationStopped = true; } };
		for (const listener of listeners.get(type) ?? []) listener(event);
		return event;
	};
	const fromParent = (data: unknown) => fire("message", { source: parent, data });
	return { posted, fire, fromParent };
}

test("the inspector posts gd:exit-focus on Shift+Esc and keeps plain Esc for the design", () => {
	const inspector = loadInspector();
	const plain = inspector.fire("keydown", { key: "Escape", shiftKey: false });
	assert.deepEqual(inspector.posted, []);
	assert.equal(plain.defaultPrevented, false);
	const chord = inspector.fire("keydown", { key: "Escape", shiftKey: true });
	assert.deepEqual(inspector.posted, [{ type: "gd:exit-focus" }]);
	assert.equal(chord.defaultPrevented, true);
	inspector.fire("keydown", { key: "Enter", shiftKey: true });
	assert.equal(inspector.posted.length, 1);
});

test("the inspector picks the element under a routed point only in comment mode", () => {
	const inspector = loadInspector();
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [], "no pick outside comment mode");
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [{ type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 } }]);
	inspector.fromParent({ type: "gd:pick-at", x: "10", y: 12 });
	assert.equal(inspector.posted.length, 1, "non-numeric points are ignored");
});

test("in focus mode the inspector leaves the wheel to the artboard and never pans the canvas", () => {
	const inspector = loadInspector();
	const wheel = { deltaX: 0, deltaY: 50, deltaMode: 0, shiftKey: false, clientX: 1, clientY: 1, target: null };
	const unfocused = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(unfocused.defaultPrevented, true);
	assert.equal(inspector.posted.at(-1).type, "gd:wheel");
	inspector.posted.length = 0;
	inspector.fromParent({ type: "gd:focus", enabled: true });
	const plain = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(plain.defaultPrevented, false, "the artboard scrolls natively");
	const zoom = inspector.fire("wheel", { ...wheel, ctrlKey: true, metaKey: false });
	assert.equal(zoom.defaultPrevented, true, "Ctrl/Cmd+wheel never zooms the browser page");
	assert.deepEqual(inspector.posted, []);
});

test("canvas assets keep the sandbox, the source check and no remote URLs", () => {
	const canvas = read("canvas.js");
	assert.match(canvas, /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
	assert.match(canvas, /candidate\.frame\.contentWindow === event\.source/);
	// Only the Compare preview of the running app (another loopback origin) may keep its own origin.
	assert.equal(canvas.split("allow-same-origin").length - 1, 1);
	assert.match(canvas, /const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";/);
	for (const name of ["index.html", "canvas.css", "canvas.js", "inspector.js"]) {
		const source = read(name);
		assert.ok(!source.includes("allow-top-navigation"), `${name} must not grant top navigation`);
		if (name !== "canvas.js") assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(source), `${name} must not parse HTML strings`);
	}
	const html = read("index.html");
	assert.match(html, /id="gd-back"[^>]*>Back to canvas</);
	assert.match(html, /id="gd-nav-mode"[^>]*>Navigating</);
});

// S15: handoff badges, the chosen artboard, and Compare.

/** Every element under `root` (itself included) that matches `test`. */
function findAll(root: FakeElement, test: (element: FakeElement) => boolean): FakeElement[] {
	const found: FakeElement[] = test(root) ? [root] : [];
	for (const child of root.children) found.push(...findAll(child, test));
	return found;
}

const withClass = (root: FakeElement, name: string) => findAll(root, (element) => element.classes.has(name));
const texts = (root: FakeElement, name: string) => withClass(root, name).map((element) => element.textContent);

function handoffDoc(chosen: string | null, handoffs: Record<string, Record<string, unknown>>) {
	const entries = Object.fromEntries(Object.entries(handoffs).map(([file, entry]) => [file, { status: "sent", queued: false, sentAt: "2026-10-26T10:00:00.000Z", startedAt: null, implementedAt: null, ...entry }]));
	return { version: 1, chosen, handoffs: entries };
}

async function setHandoffs(canvas: Awaited<ReturnType<typeof loadCanvas>>, document: unknown) {
	canvas.replies["/t/api/designs/alpha/handoffs"] = document;
	await canvas.serverEvent("change", { slug: "alpha", file: "handoffs.json" });
}

const boardsOf = (canvas: Awaited<ReturnType<typeof loadCanvas>>) => withClass(canvas.world, "gd-artboard");

test("the handoff badge follows the state live", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { queued: true } }) });
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(first, "gd-handoff-badge"), ["Queued"]);
	assert.deepEqual(texts(second, "gd-handoff-badge"), [], "an artboard never handed off has no badge");
	const states: Array<[Record<string, unknown>, string]> = [
		[{ queued: false }, "Implementing…"],
		[{ status: "in_progress", startedAt: "2026-10-26T10:01:00.000Z" }, "In progress"],
		[{ status: "implemented", implementedAt: "2026-10-26T10:02:00.000Z", note: "Done with the header" }, "Implemented ✓"],
	];
	for (const [entry, label] of states) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": entry }));
		assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), [label], label);
	}
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-note"), ["Done with the header"]);
	assert.ok(canvas.fetched.filter((url) => url === "/t/api/designs/alpha/handoffs").length >= 4, "every handoffs.json change is fetched");
	assert.equal(boardsOf(canvas)[0], first, "a handoffs.json change does not reload the artboards");
});

test("the chosen artboard gets a Chosen badge and an accent frame; the others are labeled Alternative", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc(null, {}) });
	for (const board of boardsOf(canvas)) {
		assert.deepEqual(texts(board, "gd-choice"), [], "nothing is chosen yet");
		assert.equal(board.classes.has("gd-chosen"), false);
	}
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(second, "gd-choice"), ["Chosen"]);
	assert.equal(second.classes.has("gd-chosen"), true);
	assert.deepEqual(texts(first, "gd-choice"), ["Alternative"]);
	assert.equal(first.classes.has("gd-chosen"), false);
	await setHandoffs(canvas, handoffDoc("01-a.html", { "02-b.html": {}, "01-a.html": {} }));
	assert.deepEqual(boardsOf(canvas).map((board) => texts(board, "gd-choice")[0]), ["Chosen", "Alternative"], "a new handoff moves Chosen");
});

test("Compare appears only on an implemented artboard with a loopback previewUrl other than the canvas", async () => {
	const canvas = await loadCanvas();
	const compareButtons = () => boardsOf(canvas).map((board) => withClass(board, "gd-compare-start").length);
	const cases: Array<[Record<string, unknown>, number]> = [
		[{ status: "implemented" }, 0],
		[{ status: "in_progress", previewUrl: "http://localhost:3000/" }, 0],
		[{ status: "implemented", previewUrl: "http://example.com/" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:4100/" }, 0],
		[{ status: "implemented", previewUrl: "javascript:alert(1)" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:3000/" }, 1],
		[{ status: "implemented", previewUrl: "http://[::1]:3000/" }, 1],
	];
	for (const [entry, count] of cases) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": entry }));
		assert.deepEqual(compareButtons(), [count, 0], JSON.stringify(entry));
	}
});

test("Compare shows the artboard and the sandboxed app side by side at the artboard size, and Shift+Esc or Back exits", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) });
	const overlay = canvas.document.getElementById("gd-compare");
	const panes = canvas.document.getElementById("gd-compare-panes");
	const open = () => withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	open();
	assert.equal(overlay.hidden, false);
	const frames = findAll(panes, (element) => element.localName === "iframe");
	assert.equal(frames.length, 2);
	const [artboard, preview] = frames;
	assert.equal(artboard.getAttribute("sandbox"), "allow-scripts", "the artboard stays sandboxed as on the canvas");
	assert.equal(artboard.src, "/t/files/alpha/01-a.html");
	assert.equal(preview.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms allow-popups");
	assert.equal(preview.getAttribute("referrerpolicy"), "no-referrer");
	assert.equal(preview.src, "http://localhost:5173/login");
	for (const frame of frames) assert.deepEqual([frame.style.width, frame.style.height], ["400px", "300px"]);
	const link = canvas.document.getElementById("gd-compare-open");
	assert.equal(link.href, "http://localhost:5173/login");
	assert.equal(link.getAttribute("rel"), "noopener noreferrer");
	assert.equal(link.getAttribute("target"), "_blank");
	assert.equal(canvas.viewport.inert, true, "the canvas underneath is inert");

	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const press = (shiftKey: boolean) => {
		const event: any = { key: "Escape", shiftKey, target: canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
		keydown.forEach((listener) => listener(event));
	};
	press(false);
	assert.equal(overlay.hidden, false, "plain Esc stays");
	press(true);
	assert.equal(overlay.hidden, true, "Shift+Esc exits Compare");
	assert.deepEqual(panes.children, [], "the app frame is removed");
	assert.equal(canvas.viewport.inert, false);

	open();
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(overlay.hidden, true, "Back to canvas exits Compare");

	open();
	const [shownArtboard] = findAll(panes, (element) => element.localName === "iframe");
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, false, "only the compared artboard may ask to exit");
	canvas.message(shownArtboard.contentWindow, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, true, "Shift+Esc inside the artboard exits Compare");
});

test("Compare offers scale to fit when the pair is wider than the window", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:3000/" } }) });
	const stage = canvas.document.getElementById("gd-compare-stage");
	stage.rect = { left: 0, top: 0, width: 500, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const fit = canvas.document.getElementById("gd-compare-fit");
	const field = canvas.document.getElementById("gd-compare-fit-field");
	const panes = canvas.document.getElementById("gd-compare-panes");
	assert.equal(field.hidden, false, "two 400 px boards do not fit in 500 px");
	assert.equal(panes.style.transform, "none", "Compare starts at 100%");
	fit.checked = true;
	fit.dispatch("change");
	assert.match(panes.style.transform, /^scale\(0\.\d+\)$/);
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	stage.rect = { left: 0, top: 0, width: 2000, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal(field.hidden, true, "no toggle when the pair fits");
	assert.equal(panes.style.transform, "none");
});

test("proposal controls expose selection and discard, with implementation only in the toolbar", async () => {
	const canvas = await loadCanvas(300, { "/t/api/implement": { queued: true } });
	const toast = canvas.document.getElementById("gd-toast");
	assert.match(read("index.html"), /<div id="gd-toast" class="gd-toast" role="status" aria-live="polite" hidden><\/div>/, "the toast starts hidden");
	assert.equal(withClass(canvas.world, "gd-implement-start").length, 0);
	assert.equal(withClass(canvas.world, "gd-implement-confirm").length, 0);
	assert.equal(withClass(canvas.world, "gd-discard-start").length, 2);
	for (const row of withClass(canvas.world, "gd-proposal-controls")) {
		assert.equal(row.children.length, 2);
		assert.equal(row.children[0].className, "gd-implement");
		assert.equal(row.children[1].className, "gd-discard");
	}
	assert.match(read("canvas.css"), /\.gd-proposal-controls\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/);
	const choice = withClass(canvas.world, "gd-implementation-choice")[0].children[0];
	choice.checked = true; choice.dispatch("change");
	canvas.document.getElementById("gd-implement-selected").dispatch("click");
	for (let i = 0; i < 10; i++) await flush();
	assert.deepEqual(canvas.posts.at(-1), { url: "/t/api/implement", body: { targets: [{ slug: "alpha", file: "01-a.html" }] } });
	assert.equal(toast.hidden, false);
	assert.equal(toast.textContent, "Sent 1 selected page together for implementation.");
});

test("an [::1] preview says browsers refuse to frame it, and keeps Open in new tab", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://[::1]:3000/" } }) });
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const message = canvas.document.getElementById("gd-compare-message");
	assert.equal(message.textContent, "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.");
	assert.equal(canvas.document.getElementById("gd-compare-open").href, "http://[::1]:3000/");
});
