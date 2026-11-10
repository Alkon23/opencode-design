import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { Agent, type Plugin } from "@opencode/plugin";
import { setupDesign, promptContent, type DesignPluginDeps } from "../src/plugin.ts";
import { createDesignCommentStore } from "../lib/design-comments.ts";
import { DESIGN_TOOL_NAME, DESIGN_COMMENTS_TOOL_NAME } from "../lib/design.ts";
import { createDesignStatusStore } from "../lib/design-status.ts";

type Context = Plugin.Context;
type Prompt = Parameters<Context["session"]["prompt"]>[0];
type Tool = Omit<Awaited<ReturnType<Context["tool"]["list"]>>[number], "id">;
type Command = Parameters<Parameters<Context["command"]["transform"]>[0]>[0] extends { add(value: infer V): void } ? V : never;
type HookEvent = { sessionID: string; system: Array<{ type: string; text: string }>; tools: Record<string, unknown> };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "opencode-design-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string) => {
    const directory = join(root, name);
    const design = join(directory, "design", "landing");
    mkdirSync(design, { recursive: true });
    writeFileSync(join(design, "01-calm.html"), "<!doctype html><html><body><h1 id='title'>Hello</h1></body></html>");
    writeFileSync(join(design, "design.json"), JSON.stringify({
      title: "Landing", brief: "A useful landing page", artboards: [
        { file: "01-calm.html", title: "Calm", tradeoff: "Simple", width: 1200, height: 800 },
      ],
    }));
    return directory;
  };
  return { a: write("a"), b: write("b") };
}

async function host(t: TestContext, deps: DesignPluginDeps = {}) {
  const dirs = fixture(t);
  const sessions = new Map([
    ["ses_a", { location: { directory: dirs.a }, time: {} as { archived?: number }, parentID: undefined as string | undefined }],
    ["ses_b", { location: { directory: dirs.b }, time: {} as { archived?: number }, parentID: undefined as string | undefined }],
  ]);
  const prompts: Prompt[] = [];
  const synthetic: Array<{ text: string; resume?: boolean; metadata?: Record<string, unknown> }> = [];
  const skills: unknown[] = [];
  const agents = new Map<string, Agent.Info>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const permissions: Array<{ action: string; resources?: readonly string[] }> = [];
  const storage = new Map<string, unknown>();
  const messages: Array<{ id: string; type: string; outcome?: string }> = [];
  let denied = false;
  let blocked = false;
  let promptFailure: Error | undefined;
  let permissionHook: ((input: { action: string; resources?: readonly string[] }) => void | Promise<void>) | undefined;
  let hook: (event: HookEvent) => Promise<void>;
  let listener: ((event: { type: string; data: { sessionID: string } }) => void) | undefined;
  const ctx = {
    options: {},
    // Deliberately incorrect: every operation must resolve the actual session location.
    location: { directory: "/not-the-session" },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value); } },
    skill: { transform: async (fn: (e: { add(v: unknown): void }) => void) => fn({ add: (v) => { skills.push(v); } }) },
    agent: { transform: async (fn: (e: { get(id: string): Agent.Info | undefined; update(id: string, update: (agent: Agent.Info) => void): void }) => void) => fn({
      get: id => agents.get(id),
      update: (id, update) => {
        const agent = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id));
        update(agent); agents.set(id, agent);
      },
    }) },
    session: {
	  context: async () => messages,
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error("Session not found");
        return session;
      },
      prompt: async (prompt: Prompt) => {
        prompts.push(prompt);
        if (promptFailure) throw promptFailure;
        return { delivery: prompt.delivery };
      },
      synthetic: async (message: { text: string; resume?: boolean }) => { synthetic.push(message); },
      hook: async (_name: string, fn: typeof hook) => { hook = fn; },
    },
    tool: { transform: async (fn: (e: { add(v: Tool): void }) => void) => fn({ add: (v) => { tools.set(v.name, v); } }) },
    command: { transform: async (fn: (e: { add(v: Command): void }) => void) => fn({ add: (v) => { commands.set(v.name, v); } }) },
    permission: { assert: async (input: { action: string; resources?: readonly string[] }) => {
      permissions.push(input);
      await permissionHook?.(input);
      if (denied) throw new Error("Permission denied");
      if (blocked) await new Promise<void>(() => {});
    } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const event = await new Promise<{ type: string; data: { sessionID: string } } | undefined>((resolve) => {
          const abort = () => resolve(undefined);
          signal.addEventListener("abort", abort, { once: true });
          listener = (event) => { signal.removeEventListener("abort", abort); resolve(event); };
        });
        if (event) yield event;
      }
    } },
  };
  const cleanup = await setupDesign(ctx as unknown as Context, { openBrowser: async () => ({ opened: true }), ...deps });
  t.after(cleanup);
  const invoke = (name: string, sessionID: string, input: unknown, signal = new AbortController().signal) => tools.get(name)!.execute(input, {
    sessionID, signal, agent: "build", messageID: "msg_test", id: "call_test", progress: async () => {},
  } as unknown as Parameters<Tool["execute"]>[1]);
  const command = (sessionID: string, text: string, files?: Prompt["files"]) => commands.get("design")!.execute({
    sessionID: sessionID as never, prompt: { text, files }, delivery: "queue",
  });
  return {
    dirs, sessions, prompts, synthetic, skills, agents, tools, commands, permissions, invoke, command, cleanup, messages,
    hook: (e: HookEvent) => hook(e),
    deny: () => { denied = true; }, blockPermission: () => { blocked = true; }, failPrompt: (error?: Error) => { promptFailure = error; },
    onPermission: (fn: typeof permissionHook) => { permissionHook = fn; },
    emit: async (type: string, sessionID: string, data = {}) => {
      listener!({ type, data: { sessionID, ...data } });
      // Wait until the listener advances after processing the event.
      const previous = listener;
      const deadline = Date.now() + 5000;
      while (listener === previous && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      assert.notEqual(listener, previous, "event handler completed");
    },
  };
}

async function open(h: Awaited<ReturnType<typeof host>>, sessionID = "ses_a") {
  const result = await h.invoke(DESIGN_TOOL_NAME, sessionID, { action: "open", slug: "landing" });
  const match = String(result.content).match(/http:\/\/[^\s]+/);
  assert.ok(match);
  return new URL(match[0]);
}
async function post(url: URL, route: string, body: unknown) {
  const base = url.pathname.split("/")[1];
  return fetch(`${url.origin}/${base}/${route}`, {
    method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const comment = { slug: "landing", file: "01-calm.html", selector: "#title", excerpt: "Hello", comment: "Shorter headline" };

test("import command and tool copy one original snapshot and use session permissions", async t => {
  const h = await host(t);
  const source = join(h.dirs.b, "My  snapshot.html");
  const html = '<!doctype html><html><body><h1 id="title">Signed in dashboard</h1></body></html>';
  writeFileSync(source, html);
  await h.command("ses_a", `import @"${source}"`);
  const target = join(h.dirs.a, "design", "my-snapshot", "01-original.html");
  assert.equal(readFileSync(target, "utf8"), html);
  assert.equal(readFileSync(source, "utf8"), html);
  assert.equal(h.prompts.length, 0, "mechanical import does not ask a model to regenerate the page");
  assert.ok(h.permissions.some(p => p.action === "external_directory"));
  assert.ok(h.permissions.some(p => p.action === "read" && p.resources?.includes(source)));
  assert.ok(h.permissions.some(p => p.action === "edit"));
  const url = new URL(h.synthetic.at(-1)!.text.match(/http:\/\/[^\s]+/)![0]);
  const base = `${url.origin}/${url.pathname.split("/")[1]}`;
  const rendered = await fetch(`${base}/files/my-snapshot/01-original.html`);
  assert.equal(rendered.status, 200);
  assert.match(await rendered.text(), /Signed in dashboard/);
  assert.match(rendered.headers.get("Content-Security-Policy")!, /connect-src 'none'/);
  assert.equal((await post(url, "api/comments", { ...comment, slug: "my-snapshot", mode: "collect" })).status, 400, "file must belong to the imported manifest");
  assert.equal((await post(url, "api/comments", { ...comment, slug: "my-snapshot", file: "01-original.html", mode: "collect" })).status, 201);
  await h.invoke("design_import", "ses_a", { file: pathToFileURL(source).href });
  assert.ok(existsSync(join(h.dirs.a, "design", "my-snapshot-2", "design.json")));
  await h.command("ses_a", "import", [{ uri: pathToFileURL(source).href }]);
  assert.ok(existsSync(join(h.dirs.a, "design", "my-snapshot-3", "design.json")));
  h.deny();
  await assert.rejects(h.command("ses_a", `import "${source}"`), /Permission denied/);
  assert.equal(existsSync(join(h.dirs.a, "design", "my-snapshot-4")), false);
});

test("same-page variations reserve a connected child without changing the reference", async t => {
  const h = await host(t);
  const url = await open(h);
  const manifestFile = join(h.dirs.a, "design", "landing", "design.json");
  const before = readFileSync(manifestFile, "utf8");
  const request = { id: "variant-test", file: "01-calm.html", brief: "", count: 3 };
  h.failPrompt(new Error("Lost admission response"));
  assert.equal((await post(url, "api/designs/landing/variations", request)).status, 500);
  h.failPrompt();
  const result = await post(url, "api/designs/landing/variations", request);
  assert.equal(result.status, 202);
  assert.equal((await result.json()).slug, "page-variant-test");
  assert.equal(h.prompts[0].id, h.prompts[1].id);
  assert.equal(h.prompts[1].sessionID, "ses_a");
  assert.match(h.prompts[1].text, /SAME PAGE/);
  assert.match(h.prompts[1].text, /variation-variant-test-1.html/);
  assert.match(h.prompts[1].text, /reserved CHILD design\/page-variant-test/);
  assert.match(h.prompts[1].text, /Never append variations to the reference/);
  assert.equal(readFileSync(manifestFile, "utf8"), before);
  const child = JSON.parse(readFileSync(join(h.dirs.a, "design", "page-variant-test", "design.json"), "utf8"));
  assert.deepEqual(child.parent, { slug: "landing", file: "01-calm.html" });
  assert.equal(child.requestId, request.id);
  const baseURL = `${url.origin}/${url.pathname.split("/")[1]}`;
  const family = await (await fetch(`${baseURL}/api/designs/landing/family`)).json();
  assert.ok(family.designs.some((d: { slug: string }) => d.slug === "page-variant-test"));
  assert.equal((await post(url, "api/designs/landing/variations", request)).status, 202);
  assert.equal(h.prompts.length, 2);
  assert.equal((await post(url, "api/designs/landing/variations", { ...request, brief: "changed" })).status, 409);
  assert.equal((await post(url, "api/designs/landing/pages", { ...request, brief: "New page" })).status, 409);
  assert.equal((await post(url, "api/designs/landing/variations", { ...request, id: "unsafe", file: "../escape.html" })).status, 400);
  assert.equal((await post(url, "api/designs/landing/variations", { ...request, id: "small", count: 2 })).status, 400);
  h.sessions.get("ses_a")!.location.directory = h.dirs.b;
  assert.equal((await post(url, "api/designs/landing/variations", { ...request, id: "moved" })).status, 500);
  assert.equal(h.prompts.length, 2);
});

test("imports require edit approval and refuse moves or cancellation before any copy", async t => {
  const h = await host(t);
  const source = join(h.dirs.a, "snapshot.html");
  writeFileSync(source, "<!doctype html><html><body>Captured state</body></html>");
  h.onPermission(input => { if (input.action === "edit") throw new Error("Edit forbidden"); });
  await assert.rejects(h.invoke("design_import", "ses_a", { file: source }), /Edit forbidden/);
  assert.equal(existsSync(join(h.dirs.a, "design", "snapshot")), false);
  h.onPermission(input => { if (input.action === "edit") h.sessions.get("ses_a")!.location.directory = h.dirs.b; });
  await assert.rejects(h.command("ses_a", `import "${source}"`), /session moved/);
  assert.equal(existsSync(join(h.dirs.a, "design", "snapshot")), false);
  assert.equal(existsSync(join(h.dirs.b, "design", "snapshot")), false);
  h.onPermission(undefined);
  const controller = new AbortController(); controller.abort(new Error("Cancelled import"));
  await assert.rejects(h.invoke("design_import", "ses_b", { file: source }, controller.signal), /Cancelled import/);
  assert.equal(existsSync(join(h.dirs.b, "design", "snapshot")), false);
});

test("canvas status follows native pickup/completion, not prompt admission or comment resolution", async t => {
  const h = await host(t);
  const url = await open(h);
  const endpoint = new URL(`/${url.pathname.split("/")[1]}/api/session-status`, url);
  const snapshot = async () => (await (await fetch(endpoint)).json()).requests;
  assert.deepEqual(await snapshot(), []);
  await post(url, "api/comments", { ...comment, mode: "collect" });
  assert.deepEqual(await snapshot(), [], "collected comments are not requests");
  await post(url, "api/designs/landing/comments/send-all", {});
  const firstID = h.prompts.at(-1)!.id;
  assert.equal((await snapshot())[0].status, "queued");
  await h.emit("session.inbox.delivered", "ses_b", { inboxID: firstID });
  assert.equal((await snapshot())[0].status, "queued", "another session cannot pick up this request");
  await h.emit("session.inbox.delivered", "ses_a", { inboxID: firstID });
  assert.equal((await snapshot())[0].status, "working");
  await post(url, "api/comments", { ...comment, mode: "send" });
  const secondID = h.prompts.at(-1)!.id;
  assert.deepEqual((await snapshot()).map((r: any) => r.status), ["working", "queued"]);
  await h.emit("session.inbox.delivered", "ses_a", { inboxID: secondID });
  assert.deepEqual((await snapshot()).map((r: any) => r.status).sort(), ["completed", "working"]);
  await h.emit("session.execution.succeeded", "ses_a");
  assert.ok((await snapshot()).every((r: any) => r.status === "completed"));
  const file = JSON.parse(readFileSync(join(h.dirs.a, "design", "session-status.json"), "utf8"));
  assert.equal(file.requests.length, 2);
});

test("reopening after plugin reload reconciles pending work and durable native idle outcomes", async t => {
  const h = await host(t);
  const store = createDesignStatusStore(join(h.dirs.a, "design"));
  for (const id of ["first", "second", "pending", "missing"]) await store.queue("ses_a", id, "Feedback");
  await store.pickup("ses_a", "missing");
  h.messages.push({ id: "first", type: "user" }, { id: "second", type: "user" }, { id: "end", type: "idle", outcome: "failed" });
  await open(h);
  const requests = (await store.read()).requests;
  assert.equal(requests.find(r => r.id === "first")!.status, "completed", "next queue pickup precedes later failure");
  assert.equal(requests.find(r => r.id === "second")!.status, "failed");
  assert.equal(requests.find(r => r.id === "pending")!.status, "queued");
  assert.equal(requests.find(r => r.id === "missing")!.status, "cancelled", "missing native evidence is never success");
});

test("closing the canvas does not stop tracking its agent request", async t => {
  const h = await host(t);
  const url = await open(h);
  await post(url, "api/comments", { ...comment, mode: "send" });
  await h.emit("session.inbox.delivered", "ses_a", { inboxID: h.prompts.at(-1)!.id });
  await h.command("ses_a", "stop");
  await h.emit("session.execution.succeeded", "ses_a");
  assert.equal((await createDesignStatusStore(join(h.dirs.a, "design")).read()).requests[0].status, "completed");
});

test("discard permanently removes proposal files and history without touching siblings or general feedback", async (t) => {
  const h = await host(t); const url = await open(h);
  const path = join(h.dirs.a, "design", "landing", "01-calm.html");
  const root = join(h.dirs.a, "design");
  const store = createDesignCommentStore(root);
  const shot = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]);
  const element = await store.add("landing", { file: "01-calm.html", selector: "h1", excerpt: "", comment: "Delete with proposal", screenshot: { mimeType: "image/png", data: shot } });
  const general = await store.add("landing", { scope: "general", comment: "Keep shared feedback" });
  writeFileSync(join(root, "landing", "shared.css"), "body{}");
  await post(url, "api/designs/landing/implement", { file: "01-calm.html" });
  assert.equal((await post(url, "api/designs/landing/discard", { file: "../escape.html" })).status, 400);
  assert.equal((await post(url, "api/designs/landing/discard", { file: "01-calm.html" })).status, 200);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(root, "landing", element.screenshot!)), false);
  assert.equal(readFileSync(join(root, "landing", "shared.css"), "utf8"), "body{}");
  assert.deepEqual((await store.read("landing")).comments.map(c => c.id), [general.id]);
  const handoffs = JSON.parse(readFileSync(join(root, "landing", "handoffs.json"), "utf8"));
  assert.equal(handoffs.chosen, null); assert.deepEqual(handoffs.handoffs, {});
  const manifest = JSON.parse(readFileSync(join(h.dirs.a, "design", "landing", "design.json"), "utf8"));
  assert.deepEqual(manifest.artboards, []);
  const base = `${url.origin}/${url.pathname.split("/")[1]}`;
  assert.deepEqual((await (await fetch(`${base}/api/designs/landing`)).json() as { artboards: unknown[] }).artboards, []);
  assert.equal((await post(url, "api/designs/landing/implement", { file: "01-calm.html" })).status, 400);
  assert.equal(h.prompts.length, 1, "discard does not inject a new prompt");
});

test("discard protects base proposals with connected pages", async (t) => {
  const h = await host(t); const url = await open(h);
  const folder = join(h.dirs.a, "design", "pricing"); mkdirSync(folder);
  writeFileSync(join(folder, "design.json"), JSON.stringify({ parent: { slug: "landing", file: "01-calm.html" }, artboards: [] }));
  const path = join(h.dirs.a, "design", "landing", "design.json"); const before = readFileSync(path, "utf8");
  assert.equal((await post(url, "api/designs/landing/discard", { file: "01-calm.html" })).status, 409);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("selected pages are handed off together in one originating-session prompt", async (t) => {
  const h = await host(t);
  const folder = join(h.dirs.a, "design", "pricing");
  mkdirSync(folder);
  writeFileSync(join(folder, "01-price.html"), "<h1>Pricing</h1>");
  writeFileSync(join(folder, "design.json"), JSON.stringify({ title: "Pricing", artboards: [{ file: "01-price.html", width: 900, height: 650 }] }));
  const url = await open(h);
  const targets = [{ slug: "landing", file: "01-calm.html" }, { slug: "pricing", file: "01-price.html" }];
  assert.equal((await post(url, "api/implement", { targets: [targets[0], targets[0]] })).status, 400);
  assert.equal(h.prompts.length, 0);
  assert.equal((await post(url, "api/implement", { targets })).status, 202);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].sessionID, "ses_a");
  assert.match(h.prompts[0].text, /2 selected pages together/);
  for (const target of targets) {
    assert.ok(h.prompts[0].text.includes(`${target.slug}/${target.file}`));
    const saved = JSON.parse(readFileSync(join(h.dirs.a, "design", target.slug, "handoffs.json"), "utf8"));
    assert.equal(saved.chosen, target.file);
  }
});

test("failed multi-page delivery rolls back every selected handoff", async (t) => {
  const h = await host(t);
  const folder = join(h.dirs.a, "design", "pricing"); mkdirSync(folder);
  writeFileSync(join(folder, "design.json"), JSON.stringify({ artboards: [{ file: "price.html", width: 900, height: 650 }] }));
  const url = await open(h);
  h.failPrompt(new Error("Cannot admit"));
  const targets = [{ slug: "landing", file: "01-calm.html" }, { slug: "pricing", file: "price.html" }];
  assert.equal((await post(url, "api/implement", { targets })).status, 500);
  for (const target of targets) {
    const saved = JSON.parse(readFileSync(join(h.dirs.a, "design", target.slug, "handoffs.json"), "utf8"));
    assert.equal(saved.chosen, null);
    assert.deepEqual(saved.handoffs, {});
  }
});

test("new page requests preserve the base, reserve linked alternatives and retry to the originating session", async (t) => {
  const h = await host(t);
  const url = await open(h);
  const base = join(h.dirs.a, "design", "landing", "01-calm.html");
  const original = readFileSync(base, "utf8");
  const request = { id: "page-test-1", file: "01-calm.html", brief: "Pricing page with annual plans", count: 4 };
  h.failPrompt(new Error("Lost admission response"));
  assert.equal((await post(url, "api/designs/landing/pages", request)).status, 500);
  h.failPrompt();
  const response = await post(url, "api/designs/landing/pages", request);
  assert.equal(response.status, 202);
  const saved = await response.json() as { slug: string };
  assert.equal(h.prompts[0].id, h.prompts[1].id);
  assert.equal(h.prompts[1].sessionID, "ses_a");
  assert.match(h.prompts[1].text, /Pricing page with annual plans/);
  assert.match(h.prompts[1].text, /4.*proposals/);
  assert.match(h.prompts[1].text, /headers.*footers/);
  assert.match(h.prompts[1].text, /design\/landing\/01-calm.html/);
  const manifest = JSON.parse(readFileSync(join(h.dirs.a, "design", saved.slug, "design.json"), "utf8"));
  assert.deepEqual(manifest.parent, { slug: "landing", file: "01-calm.html" });
  assert.equal(manifest.requestId, request.id);
  assert.equal(readFileSync(base, "utf8"), original);
  assert.equal((await post(url, "api/designs/landing/pages", request)).status, 202);
  assert.equal(h.prompts.length, 2, "successful request is not admitted twice");
  assert.equal((await post(url, "api/designs/landing/pages", { ...request, brief: "Changed" })).status, 409);
  assert.equal((await post(url, "api/designs/landing/pages", { ...request, id: "invalid-file", file: "../escape.html" })).status, 400);
  assert.equal((await post(url, "api/designs/landing/pages", { ...request, id: "too-few", count: 2 })).status, 400);
  const baseURL = `${url.origin}/${url.pathname.split("/")[1]}`;
  const family = await (await fetch(`${baseURL}/api/designs/${saved.slug}/family`)).json() as { designs: Array<{ slug: string }> };
  assert.deepEqual(new Set(family.designs.map((d) => d.slug)), new Set(["landing", saved.slug]));
  const before = readFileSync(join(h.dirs.a, "design", "page-requests.json"), "utf8");
  assert.equal((await fetch(`${baseURL}/api/designs/landing/pages`, { method: "POST", headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ ...request, id: "foreign" }) })).status, 403);
  assert.equal(readFileSync(join(h.dirs.a, "design", "page-requests.json"), "utf8"), before);
});

test("tampered reserved child cannot redirect generation into its base", async (t) => {
  const h = await host(t);
  const url = await open(h);
  const request = { id: "reserved-isolation", file: "01-calm.html", brief: "Pricing page", count: 3 };
  h.failPrompt(new Error("Ambiguous admission"));
  assert.equal((await post(url, "api/designs/landing/pages", request)).status, 500);
  const history = join(h.dirs.a, "design", "page-requests.json");
  const document = JSON.parse(readFileSync(history, "utf8"));
  document.requests[0].slug = "landing";
  document.requests[0].sent = false;
  writeFileSync(history, JSON.stringify(document));
  const before = readFileSync(history);
  const deliveries = h.prompts.length;
  h.failPrompt();
  const response = await post(url, "api/designs/landing/pages", request);
  assert.ok(response.status >= 400);
  assert.equal(h.prompts.length, deliveries);
  assert.deepEqual(readFileSync(history), before);
});

test("new page requests serialize double submits and refuse moved sessions and damaged history", async (t) => {
  const h = await host(t);
  const url = await open(h);
  const request = { id: "one-page", file: "01-calm.html", brief: "Pricing", count: 3 };
  const replies = await Promise.all([post(url, "api/designs/landing/pages", request), post(url, "api/designs/landing/pages", request)]);
  assert.ok(replies.every((r) => r.status === 202));
  assert.equal(h.prompts.length, 1);
  h.sessions.get("ses_a")!.location.directory = h.dirs.b;
  const moved = await post(url, "api/designs/landing/pages", { ...request, id: "moved-page" });
  assert.equal(moved.status, 500);
  assert.equal(h.prompts.length, 1, "never redirect to another location");
  const path = join(h.dirs.a, "design", "page-requests.json");
  writeFileSync(path, "broken");
  assert.equal((await post(url, "api/designs/landing/pages", { ...request, id: "broken-page" })).status, 500);
  assert.equal(readFileSync(path, "utf8"), "broken");
});

test("child family includes only its exact parent reference and descendants", async (t) => {
  const h = await host(t);
  const root = join(h.dirs.a, "design");
  const write = (slug: string, parent?: { slug: string; file: string }) => {
    mkdirSync(join(root, slug), { recursive: true });
    writeFileSync(join(root, slug, "design.json"), JSON.stringify({ title: slug, parent, artboards: ["1.html", "2.html"].map(file => ({ file, width: 400, height: 300 })) }));
  };
  write("initial"); write("child", { slug: "initial", file: "2.html" });
  write("sibling", { slug: "initial", file: "1.html" });
  write("grandchild", { slug: "child", file: "1.html" });
  const url = await open(h);
  const api = `${url.origin}/${url.pathname.split("/")[1]}/api/designs`;
  const family = await (await fetch(`${api}/child/family`)).json() as { designs: Array<{ slug: string; artboards: Array<{ file: string }> }> };
  assert.deepEqual(family.designs.map(d => d.slug), ["initial", "child", "grandchild"]);
  assert.deepEqual(family.designs[0].artboards.map(b => b.file), ["2.html"]);
  const listed = await (await fetch(api)).json() as { designs: Array<{ slug: string; parent?: unknown }> };
  assert.deepEqual(listed.designs.find(d => d.slug === "child")!.parent, { slug: "initial", file: "2.html" });
  assert.equal(listed.designs.find(d => d.slug === "initial")!.parent, undefined);
});

test("family traversal isolates missing and cyclic references and validates parent paths", async (t) => {
  const h = await host(t);
  const root = join(h.dirs.a, "design");
  const write = (slug: string, parent: unknown) => {
    mkdirSync(join(root, slug), { recursive: true });
    writeFileSync(join(root, slug, "design.json"), JSON.stringify({ title: slug, parent, artboards: [{ file: "01-calm.html", width: 400, height: 300 }] }));
  };
  write("child", { slug: "landing", file: "01-calm.html" });
  const url = await open(h);
  const api = `${url.origin}/${url.pathname.split("/")[1]}/api/designs`;
  let family = await (await fetch(`${api}/child/family`)).json() as { designs: unknown[]; warnings: string[] };
  assert.equal(family.designs.length, 2);
  write("landing", { slug: "child", file: "01-calm.html" });
  family = await (await fetch(`${api}/child/family`)).json() as typeof family;
  assert.ok(family.warnings.some((w) => /cyclic/.test(w)));
  write("child", { slug: "missing", file: "01-calm.html" });
  family = await (await fetch(`${api}/child/family`)).json() as typeof family;
  assert.ok(family.designs.length >= 1);
  assert.ok(family.warnings.length > 0);
  write("invalid", { slug: "landing", file: "../secret.html" });
  assert.equal((await fetch(`${api}/invalid`)).status, 422);
});

test("system feedback retries to its owner with screenshots and separate scope, and overrides require edit permission", async (t) => {
  const h = await host(t);
  await h.invoke("design_system", "ses_a", { action: "sync", tokens: [{ key: "primary", group: "color", value: "red", source: "theme.css" }] });
  const url = await open(h);
  const screenshot = { mimeType: "image/png", data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]).toString("base64") };
  h.failPrompt(new Error("Lost response"));
  const saved = await post(url, "api/comments", { scope: "system", comment: "Use blue", screenshot });
  assert.equal(saved.status, 500);
  const id = (await saved.json() as { id: string }).id;
  assert.match(h.prompts[0].text, /preview overrides only/);
  assert.match(h.prompts[0].files![0].uri, /^data:image\/png/);
  h.failPrompt();
  assert.equal((await post(url, "api/system/comments/send-all", {})).status, 202);
  assert.equal(h.prompts[0].id, h.prompts[1].id);
  assert.equal(h.prompts[1].sessionID, "ses_a");
  const base = url.pathname.split("/")[1];
  const shot = await fetch(`${url.origin}/${base}/api/system/comments/${id}/screenshot`);
  assert.equal(shot.status, 200);
  const listed = await h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_a", { action: "list", scope: "system" });
  assert.match(String(listed.content), /Use blue/);
  assert.doesNotMatch(String((await h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_b", { action: "list", scope: "system" })).content), /Use blue/);
  assert.equal((await post(url, `api/system/comments/${id}/status`, { status: "resolved" })).status, 200);
  assert.equal((await post(url, "api/comments", { scope: "system", slug: "landing", comment: "wrong" })).status, 400);
  h.deny();
  await assert.rejects(h.invoke("design_system", "ses_a", { action: "set", key: "primary", value: "blue" }), /Permission denied/);
  const state = String((await h.invoke("design_system", "ses_a", { action: "list" })).content);
  assert.match(state, /red/);
  assert.doesNotMatch(state, /blue/);
});

test("registers the bundled skill, /design, and four native V2 tools", async (t) => {
  const h = await host(t);
  assert.equal(h.skills.length, 1);
  assert.deepEqual([...h.tools.keys()], ["design_import", "design_canvas", "design_comments", "design_system"]);
  assert.deepEqual([...h.commands.keys()], ["design"]);
  assert.ok(JSON.stringify(h.skills).includes('opencode-design'));
  assert.equal(h.agents.get("design")?.name, "Design");
  assert.match(h.agents.get("design")!.system!, /implementation not started/);
  assert.match(h.tools.get(DESIGN_COMMENTS_TOOL_NAME)!.description!, /named slug must already exist/);
  assert.match(JSON.stringify(h.tools.get("design_system")!.input), /current-project-relative path/);
});

test("brief and sync commands attach the skill and preserve prompt files", async (t) => {
  const h = await host(t);
  await h.command("ses_a", "A helpful landing page", [{ uri: "data:text/plain,brief" }]);
  assert.equal(h.prompts[0].text, "A helpful landing page");
  assert.deepEqual(h.prompts[0].skills, [{ id: "opencode-design" }]);
  assert.equal(h.prompts[0].files?.[0].uri, "data:text/plain,brief");
  await h.command("ses_b", "sync");
  assert.match(h.prompts[1].text, /design system/);
  await assert.rejects(h.command("ses_a", "sync extra"), /no arguments/);
});

test("open and stop commands report notices without triggering model execution", async (t) => {
  const h = await host(t);
  await h.command("ses_a", "");
  assert.match(h.synthetic[0].text, /Design canvas:/);
  assert.equal(h.synthetic[0].resume, false);
  const url = h.synthetic[0].text.match(/http:\/\/[^\s]+/)![0];
  assert.equal((await fetch(url)).status, 200);
  await h.command("ses_a", "stop");
  await assert.rejects(fetch(url));
  assert.deepEqual(h.synthetic.at(-1)!.metadata, { source: "opencode-design", action: "stop", directory: await realpath(h.dirs.a), stopped: true });
  await h.command("ses_a", "stop");
  assert.equal(h.synthetic.at(-1)!.metadata?.stopped, false);
  assert.equal(h.synthetic.at(-1)!.resume, false);
  assert.equal(h.prompts.length, 0);
});

test("failed shutdown does not publish a successful stop notice", async (t) => {
  const h = await host(t, { createCanvas: () => ({
    open: async () => ({ message: "unused", level: "info" }),
    stop: async () => { throw new Error("Shutdown failed"); }, url: () => undefined,
  }) });
  await assert.rejects(h.command("ses_a", "stop"), /Shutdown failed/);
  assert.equal(h.synthetic.length, 0);
});

test("implementation command queues exactly one prompt to its originating session", async (t) => {
  const h = await host(t);
  await h.command("ses_b", "implement landing/01-calm.html");
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].sessionID, "ses_b");
  assert.match(h.prompts[0].text, /design\/landing\/01-calm.html/);
  assert.equal(h.prompts[0].delivery, "queue");
});

test("list reports design sources and missing/stale tokens", async (t) => {
  const h = await host(t);
  writeFileSync(join(h.dirs.a, "tokens.json"), '{"color":"blue"}');
  const result = await h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "list" });
  assert.match(String(result.content), /tokens.json/);
  assert.match(String(result.content), /sync before designing/);
});

test("real HTTP comments go only to the session that opened each canvas", async (t) => {
  const h = await host(t);
  const a = await open(h, "ses_a");
  const b = await open(h, "ses_b");
  assert.notEqual(a.port, b.port);
  assert.equal((await post(a, "api/comments", comment)).status, 202);
  assert.equal((await post(b, "api/comments", { ...comment, comment: "Larger headline" })).status, 202);
  assert.deepEqual(h.prompts.map((p) => p.sessionID), ["ses_a", "ses_b"]);
  assert.ok(h.prompts.every((p) => p.delivery === "queue"));
  assert.equal((await createDesignCommentStore(join(h.dirs.a, "design")).listOpen("landing"))[0].sentAt !== null, true);
  assert.equal(await realpath(h.dirs.a), h.prompts[0].metadata?.directory);
});

test("collect, screenshot attachments, batch submission and resolution work end to end", async (t) => {
  const h = await host(t);
  const url = await open(h);
  const screenshot = { mimeType: "image/png", data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]).toString("base64") };
  const saved = await post(url, "api/comments", { ...comment, mode: "collect", screenshot });
  assert.equal(saved.status, 201);
  const { id } = await saved.json() as { id: string };
  assert.equal(h.prompts.length, 0);
  assert.equal((await post(url, "api/designs/landing/comments/send-all", {})).status, 202);
  assert.match(h.prompts[0].files![0].uri, /^data:image\/png;base64,/);
  await h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_a", { action: "resolve", slug: "landing", ids: [id] });
  assert.deepEqual(await createDesignCommentStore(join(h.dirs.a, "design")).listOpen("landing"), []);
});

test("general feedback supports screenshots, retries, file-filtered listing, and explicit resolution", async (t) => {
  const h = await host(t);
  const url = await open(h);
  const screenshot = { mimeType: "image/png", data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0]).toString("base64") };
  h.failPrompt(new Error("Response lost"));
  const response = await post(url, "api/comments", { slug: "landing", scope: "general", comment: "Add testimonials to all proposals", screenshot });
  assert.equal(response.status, 500);
  const saved = await response.json() as { id: string };
  assert.match(h.prompts[0].text, /Scope: All proposals/);
  assert.match(h.prompts[0].files![0].uri, /^data:image\/png;base64,/);
  await post(url, "api/comments", { ...comment, mode: "collect" });
  h.failPrompt();
  assert.equal((await post(url, "api/designs/landing/comments/send-all", {})).status, 202);
  assert.equal(h.prompts[0].id, h.prompts[1].id);
  assert.equal(h.prompts[1].sessionID, "ses_a");
  const listed = await h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_a", { action: "list", slug: "landing", file: "01-calm.html" });
  assert.match(String(listed.content), /All proposals \(general comment\)/);
  const handoff = await h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "implement", target: "landing/01-calm.html" });
  assert.match(String(handoff.content), /General comments remain design-wide/);
  const resolveLine = String(handoff.content).split("\n").find((line) => line.startsWith("When they are applied"));
  assert.ok(resolveLine && !resolveLine.includes(saved.id), "handoff must not instruct resolution of a general comment after one implementation");
  await h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_a", { action: "resolve", slug: "landing", ids: [saved.id] });
  const history = await createDesignCommentStore(join(h.dirs.a, "design")).read("landing");
  assert.equal(history.comments.find((c) => c.id === saved.id)!.status, "resolved");
  assert.equal(history.comments.find((c) => c.scope !== "general")!.status, "open");
});

test("failed batch admission keeps comments unsent and retry reuses its inbox ID", async (t) => {
  const h = await host(t);
  const url = await open(h);
  await post(url, "api/comments", { ...comment, mode: "collect" });
  h.failPrompt(new Error("Service unavailable"));
  assert.equal((await post(url, "api/designs/landing/comments/send-all", {})).status, 500);
  const store = createDesignCommentStore(join(h.dirs.a, "design"));
  assert.equal((await store.listOpen("landing"))[0].sentAt, null);
  h.failPrompt();
  assert.equal((await post(url, "api/designs/landing/comments/send-all", {})).status, 202);
  assert.equal(h.prompts[0].id, h.prompts[1].id);
  assert.notEqual((await store.listOpen("landing"))[0].sentAt, null);
});

test("a failed Send now keeps its ID when retried alongside new collected comments", async (t) => {
  const h = await host(t);
  const url = await open(h);
  h.failPrompt(new Error("Response lost after admission"));
  assert.equal((await post(url, "api/comments", comment)).status, 500);
  const firstID = h.prompts[0].id;
  await post(url, "api/comments", { ...comment, comment: "New feedback", mode: "collect" });
  h.failPrompt();
  assert.equal((await post(url, "api/designs/landing/comments/send-all", {})).status, 202);
  assert.equal(h.prompts[1].id, firstID);
  assert.notEqual(h.prompts[2].id, firstID);
  assert.match(h.prompts[2].text, /New feedback/);
  assert.doesNotMatch(h.prompts[2].text, /Shorter headline/);
});

test("two canvases sharing a design root do not deliver the same batch twice", async (t) => {
  const h = await host(t);
  h.sessions.get("ses_b")!.location.directory = h.dirs.a;
  const a = await open(h, "ses_a");
  const b = await open(h, "ses_b");
  await post(a, "api/comments", { ...comment, mode: "collect" });
  const responses = await Promise.all([
    post(a, "api/designs/landing/comments/send-all", {}),
    post(b, "api/designs/landing/comments/send-all", {}),
  ]);
  assert.ok(responses.every((r) => r.status === 200 || r.status === 202));
  assert.equal(h.prompts.length, 1);
});

test("canvas Implement queues a handoff, tools report progress, and preview is persisted", async (t) => {
  const h = await host(t);
  const url = await open(h);
  assert.equal((await post(url, "api/designs/landing/implement", { file: "01-calm.html" })).status, 202);
  assert.match(h.prompts[0].text, /real stack/);
  assert.doesNotMatch(h.prompts[0].text, /ODD|odd\/tasks/);
  await h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "handoff", target: "landing/01-calm.html", status: "in_progress" });
  await h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "handoff", target: "landing/01-calm.html", status: "implemented", previewUrl: "http://localhost:5173/" });
  const document = JSON.parse(readFileSync(join(h.dirs.a, "design", "landing", "handoffs.json"), "utf8"));
  assert.equal(document.chosen, "01-calm.html");
  assert.equal(document.handoffs["01-calm.html"].status, "implemented");
  assert.equal(document.handoffs["01-calm.html"].previewUrl, "http://localhost:5173/");
});

test("implementation tool returns instructions without injecting a second prompt", async (t) => {
  const h = await host(t);
  const result = await h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "implement", target: "landing/01-calm.html" });
  assert.match(String(result.content), /visual spec/);
  assert.equal(h.prompts.length, 0);
});

test("moved and archived sessions reject feedback; deletion and unload close sockets", async (t) => {
  const h = await host(t);
  const a = await open(h, "ses_a");
  h.sessions.get("ses_a")!.location.directory = h.dirs.b;
  assert.equal((await post(a, "api/comments", comment)).status, 500);
  assert.equal(h.prompts.length, 0);
  await h.emit("session.moved", "ses_a");
  await assert.rejects(fetch(a));
  const b = await open(h, "ses_b");
  h.sessions.get("ses_b")!.time.archived = Date.now();
  assert.equal((await post(b, "api/comments", comment)).status, 500);
  await h.emit("session.deleted", "ses_b");
  await assert.rejects(fetch(b));
  const newA = await open(h, "ses_a");
  await h.cleanup();
  await assert.rejects(fetch(newA));
});

test("permissions and cancellation block side effects", async (t) => {
  const h = await host(t);
  h.deny();
  await assert.rejects(open(h), /Permission denied/);
  const signal = AbortSignal.abort();
  await assert.rejects(h.invoke(DESIGN_TOOL_NAME, "ses_a", { action: "open" }, signal));
  await assert.rejects(h.invoke(DESIGN_COMMENTS_TOOL_NAME, "ses_a", { action: "resolve", slug: "landing", ids: ["a"] }), /Permission denied/);
});

test("plugin unload does not hang on an unanswered permission prompt", async (t) => {
  const h = await host(t);
  h.blockPermission();
  const opening = assert.rejects(open(h));
  for (let i = 0; !h.permissions.length && i < 100; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.permissions.length, 1);
  await h.cleanup();
  await opening;
  assert.equal(h.prompts.length, 0);
});

test("prompt hint stays out of delegated sessions and agents without the canvas tool", async (t) => {
  const h = await host(t);
  const event = { sessionID: "ses_a", system: [], tools: { design_canvas: {} } };
  await h.hook(event);
  assert.equal(event.system.length, 1);
  h.sessions.get("ses_a")!.parentID = "ses_parent";
  event.system = [];
  await h.hook(event);
  assert.equal(event.system.length, 0);
  await h.hook({ ...event, sessionID: "ses_b", tools: {} });
});

test("plain prompt conversion has no attachments", () => {
  assert.deepEqual(promptContent("feedback"), { text: "feedback" });
});
