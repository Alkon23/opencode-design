import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { setupDesign, promptContent, type DesignPluginDeps } from "../src/plugin.ts";
import { createDesignCommentStore } from "../lib/design-comments.ts";
import { DESIGN_TOOL_NAME, DESIGN_COMMENTS_TOOL_NAME } from "../lib/design.ts";

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
  const synthetic: Array<{ text: string; resume?: boolean }> = [];
  const skills: unknown[] = [];
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const permissions: Array<{ action: string; resources?: readonly string[] }> = [];
  const storage = new Map<string, unknown>();
  let denied = false;
  let blocked = false;
  let promptFailure: Error | undefined;
  let hook: (event: HookEvent) => Promise<void>;
  let listener: ((event: { type: string; data: { sessionID: string } }) => void) | undefined;
  const ctx = {
    options: {},
    // Deliberately incorrect: every operation must resolve the actual session location.
    location: { directory: "/not-the-session" },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value); } },
    skill: { transform: async (fn: (e: { add(v: unknown): void }) => void) => fn({ add: (v) => { skills.push(v); } }) },
    session: {
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
    dirs, sessions, prompts, synthetic, skills, tools, commands, permissions, invoke, command, cleanup,
    hook: (e: HookEvent) => hook(e),
    deny: () => { denied = true; }, blockPermission: () => { blocked = true; }, failPrompt: (error?: Error) => { promptFailure = error; },
    emit: async (type: string, sessionID: string) => {
      listener!({ type, data: { sessionID } });
      // Wait until the listener advances after processing the event.
      const previous = listener;
      for (let i = 0; listener === previous && i < 100; i++) await new Promise((r) => setImmediate(r));
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

test("registers the bundled skill, /design, and two native V2 tools", async (t) => {
  const h = await host(t);
  assert.equal(h.skills.length, 1);
  assert.deepEqual([...h.tools.keys()], ["design_canvas", "design_comments"]);
  assert.deepEqual([...h.commands.keys()], ["design"]);
  assert.ok(JSON.stringify(h.skills).includes('opencode-design'));
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
  assert.equal(h.prompts.length, 0);
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
