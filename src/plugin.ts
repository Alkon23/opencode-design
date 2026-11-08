import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Skill, type Plugin } from "@opencode/plugin";
import {
  createDesignCanvas, DESIGN_COMMENTS_TOOL_NAME, DESIGN_HELP, DESIGN_PROMPT_HINT,
  DESIGN_SKILL_NAME, DESIGN_SYNC_REQUEST, DESIGN_TOOL_NAME, designUsage, hasSystemBoard,
  listDesigns, parseDesignArgs, planDesignImplement, runDesignCommentsTool, runDesignTool,
  sendDesignImplement, type DesignCanvas, type DesignCanvasDeps,
  type DesignCommentsToolParams, type DesignToolParams,
} from "../lib/design.ts";
import { designCommentBatchContent, type DesignComment, type DesignSessionContent } from "../lib/design-canvas-server.ts";
import { runDesignSystemTool, TOKEN_GROUPS, type SystemToolParams } from "../lib/design-system.ts";
import type { DesignPageRequest } from "../lib/design-pages.ts";
import { registerDesignAgent } from "./design-agent.ts";

type Context = Plugin.Context;
type SessionID = Parameters<Context["session"]["get"]>[0]["sessionID"];
type Prompt = Parameters<Context["session"]["prompt"]>[0];
type Execution = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
const skillPath = fileURLToPath(new URL("../skills/design/SKILL.md", import.meta.url));

const canvasInput = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { type: "string", enum: ["list", "open", "stop", "implement", "handoff"] },
    slug: { type: "string" }, target: { type: "string" },
    status: { type: "string", enum: ["in_progress", "implemented"] },
    note: { type: "string", maxLength: 1000 }, previewUrl: { type: "string", maxLength: 2048 },
  },
} as const;
const commentsInput = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { type: "string", enum: ["list", "resolve"] }, slug: { type: "string" },
    scope: { type: "string", enum: ["system"] },
    file: { type: "string" }, ids: { type: "array", items: { type: "string" }, maxItems: 500 },
  },
} as const;

/** Convert portable canvas content to V2 prompt attachments, never exposing server credentials. */
export function promptContent(content: DesignSessionContent): Pick<Prompt, "text" | "files"> {
  if (typeof content === "string") return { text: content };
  return {
    text: content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"),
    files: content.filter((part) => part.type === "image").map((part) => ({
      uri: `data:${part.mimeType};base64,${part.data}`,
    })),
  };
}

export interface DesignPluginDeps extends DesignCanvasDeps {
  /** Dependency injection for adapter tests; production uses the bundled canvas. */
  createCanvas?: typeof createDesignCanvas;
}

export async function setupDesign(ctx: Context, deps: DesignPluginDeps = {}): Promise<() => Promise<void>> {
  await registerDesignAgent(ctx);
  const skill = await readFile(skillPath, "utf8");
  const skillID = Skill.ID.make(DESIGN_SKILL_NAME);
  const controller = new AbortController();
  let disposed = false;
  const entries = new Map<SessionID, { directory: string; canvas: DesignCanvas }>();
  // Serialize lifecycle changes for each session (open/stop/move/unload).
  const operations = new Map<SessionID, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();

  async function permission(input: Parameters<Context["permission"]["assert"]>[0], toolSignal?: AbortSignal) {
    const signal = toolSignal ? AbortSignal.any([controller.signal, toolSignal]) : controller.signal;
    signal.throwIfAborted();
    let abort: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        ctx.permission.assert(input).then(resolve, reject);
      });
    } finally { signal.removeEventListener("abort", abort!); }
  }

  async function exclusive<T>(sessionID: SessionID, work: () => Promise<T>): Promise<T> {
    const previous = operations.get(sessionID) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => {
      if (disposed) throw new Error("OpenCode Design has unloaded.");
      return work();
    });
    operations.set(sessionID, run);
    pending.add(run);
    try { return await run; }
    finally {
      pending.delete(run);
      if (operations.get(sessionID) === run) operations.delete(sessionID);
    }
  }

  async function location(sessionID: SessionID) {
    const session = await ctx.session.get({ sessionID });
    if (session.time.archived !== undefined) throw new Error("The design session is archived.");
    return { session, directory: await realpath(session.location.directory) };
  }

  async function stop(sessionID: SessionID) {
    const entry = entries.get(sessionID);
    entries.delete(sessionID);
    await entry?.canvas.stop();
  }

  async function deliver(sessionID: SessionID, directory: string, content: DesignSessionContent) {
    if (disposed) throw new Error("OpenCode Design has unloaded.");
    const current = await location(sessionID);
    if (current.directory !== directory) throw new Error("The session moved. Reopen the canvas from its new directory.");
    const prompt = promptContent(content);
    // Handoffs are explicit repeatable user actions; comments use the journal below.
    const key = randomUUID();
    await ctx.session.prompt({
      ...prompt, sessionID, id: `msg_design_${key}` as Prompt["id"],
      skills: [{ id: skillID }], delivery: "queue",
      metadata: { source: "opencode-design", directory },
    }, { signal: controller.signal });
    return { queued: true };
  }

  async function deliverComments(sessionID: SessionID, directory: string, comments: DesignComment[]) {
    // Journal membership BEFORE admission. If admission succeeds but its response is
    // lost, a retry (even Send now -> Send all with new comments) reuses the old inbox ID.
    const groups = new Map<string, { sessionID: SessionID; comments: DesignComment[] }>();
    const freshID = `msg_design_${createHash("sha256").update(JSON.stringify([
      directory, sessionID, comments.map((c) => [c.scope === "system" ? { scope: "system" } : c.slug, c.id]).sort(),
    ])).digest("hex")}`;
    for (const comment of comments) {
      const key = `delivery/${createHash("sha256").update(JSON.stringify([directory, comment.scope === "system" ? { scope: "system" } : comment.slug, comment.id])).digest("hex")}`;
      const saved = await ctx.storage.get(key);
      let owner: SessionID = sessionID;
      let id = freshID;
      if (saved !== undefined) {
        if (!saved || typeof saved !== "object" || !("id" in saved) || !("sessionID" in saved) || typeof saved.id !== "string" || typeof saved.sessionID !== "string") {
          throw new Error("Invalid design delivery journal; refusing to redirect feedback.");
        }
        id = saved.id;
        owner = saved.sessionID as SessionID;
      } else await ctx.storage.set(key, { id, sessionID });
      const group = groups.get(id) ?? { sessionID: owner, comments: [] };
      group.comments.push(comment);
      groups.set(id, group);
    }
    for (const [id, group] of groups) {
      const current = await location(group.sessionID);
      if (disposed || current.directory !== directory) throw new Error("The feedback session moved or closed; comments remain unsent.");
      await ctx.session.prompt({
        ...promptContent(designCommentBatchContent(group.comments)),
        sessionID: group.sessionID, id: id as Prompt["id"], delivery: "queue",
        skills: [{ id: skillID }], metadata: { source: "opencode-design", directory },
      }, { signal: controller.signal });
    }
    return { queued: true };
  }

  async function deliverPage(sessionID: SessionID, directory: string, content: DesignSessionContent, page: DesignPageRequest) {
    const key = `page-delivery/${createHash("sha256").update(JSON.stringify([directory, page.id])).digest("hex")}`;
    const saved = await ctx.storage.get(key);
    let owner = sessionID;
    if (saved !== undefined) {
      if (!saved || typeof saved !== "object" || !("sessionID" in saved) || typeof saved.sessionID !== "string") throw new Error("Invalid page delivery journal; refusing to redirect request");
      owner = saved.sessionID as SessionID;
    } else await ctx.storage.set(key, { sessionID });
    const current = await location(owner);
    if (disposed || current.directory !== directory) throw new Error("The page request session moved or closed; request remains unsent");
    await ctx.session.prompt({ ...promptContent(content), sessionID: owner,
      id: `msg_design_page_${createHash("sha256").update(JSON.stringify([directory, page.id])).digest("hex")}` as Prompt["id"],
      delivery: "queue", skills: [{ id: skillID }], metadata: { source: "opencode-design", directory },
    }, { signal: controller.signal });
    return { queued: true };
  }

  async function entryFor(sessionID: SessionID) {
    const { directory } = await location(sessionID);
    let entry = entries.get(sessionID);
    if (entry && entry.directory !== directory) {
      await stop(sessionID);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        directory,
        canvas: (deps.createCanvas ?? createDesignCanvas)(
          (content, comments, page) => page ? deliverPage(sessionID, directory, content, page) : comments ? deliverComments(sessionID, directory, comments) : deliver(sessionID, directory, content),
          { ...deps, ...(ctx.options.openBrowser === false ? { openBrowser: async () => ({ opened: false }) } : {}) },
        ),
      };
      entries.set(sessionID, entry);
    }
    return entry;
  }

  await ctx.skill.transform((editor) => editor.add({
    id: skillID, name: Skill.Name.make(DESIGN_SKILL_NAME),
    description: "Trigger: UI design, mockup, landing page, artboards, design system sync. Design and iterate using the visual canvas.",
    path: Skill.Info.fields.path.make(skillPath),
    content: skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), autoinvoke: true,
  }));

  await ctx.session.hook("context", async (event) => {
    // Only advertise tools actually available to the active agent.
    if (!event.tools[DESIGN_TOOL_NAME]) return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (session.parentID) return;
    event.system.push({ type: "text", text: DESIGN_PROMPT_HINT });
  });

  await ctx.tool.transform((editor: Execution) => {
    editor.add({
      name: DESIGN_TOOL_NAME, input: canvasInput,
      description: "List design proposals, project design sources and token staleness; open/refresh or stop the canvas; implement a chosen artboard; report handoff progress and a running loopback previewUrl. Call list before designing; generate HTML following the opencode-design skill.",
      execute: async (input, context) => exclusive(context.sessionID, async () => {
        context.signal.throwIfAborted();
        const params = input as DesignToolParams;
        const { directory, canvas } = await entryFor(context.sessionID);
        if (params.action !== "list") await permission({
          sessionID: context.sessionID, agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
          action: params.action === "handoff" || params.action === "implement" ? "edit" : DESIGN_TOOL_NAME,
          resources: [join(directory, "design", "**")], save: [join(directory, "design", "**")],
        }, context.signal);
        context.signal.throwIfAborted();
        const result = await runDesignTool(directory, params, canvas);
        return { content: result.texts.join("\n\n") };
      }),
    });
    editor.add({
      name: DESIGN_COMMENTS_TOOL_NAME, input: commentsInput,
      description: "List open canvas comments, including project-wide system feedback. A named slug must already exist: list designs first and generate new proposals before querying their comments. scope system lists/resolves only design-system comments (omit slug/file). Proposal file filters include applicable general comments. System feedback changes preview overrides only, never application sources. Resolve only after the requested previews are updated.",
      execute: async (input, context) => exclusive(context.sessionID, async () => {
        context.signal.throwIfAborted();
        const params = input as DesignCommentsToolParams;
        const { directory } = await location(context.sessionID);
        if (params.action === "resolve") await permission({
          sessionID: context.sessionID, agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id }, action: "edit",
          resources: [params.scope === "system" ? join(directory, "design", "system-comments.json") : join(directory, "design", params.slug ?? "*", "comments.json")],
        }, context.signal);
        context.signal.throwIfAborted();
        return { content: (await runDesignCommentsTool(directory, params)).text };
      }),
    });
    editor.add({
      name: "design_system",
      description: "Manage preview-only design-system tokens. list returns source/effective tokens, overrides and conflicts. sync accepts a sourced token snapshot and preserves overrides; set changes one preview override; remove restores its source value. Mutations regenerate system.md/html only; refresh affected proposals separately. Never modify application sources.",
      input: { type: "object", additionalProperties: false, required: ["action"], properties: {
        action: { type: "string", enum: ["list", "sync", "set", "remove"] }, key: { type: "string" }, value: { type: "string" }, reason: { type: "string" },
        tokens: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["key", "group", "value", "source"], properties: {
          key: { type: "string" }, group: { type: "string", enum: [...TOKEN_GROUPS] }, value: { type: "string" }, source: { type: "string", description: "Actual current-project-relative path (e.g. src/styles.css), or proposed for an approved starter/adopted external palette. Never an absolute path, URL or ../ path; keep external reference provenance in the brief/specification." },
        } } },
      } },
      execute: async (input, context) => exclusive(context.sessionID, async () => {
        const params = input as SystemToolParams;
        context.signal.throwIfAborted();
        const { directory } = await location(context.sessionID);
        if (params.action !== "list") await permission({ sessionID: context.sessionID, agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id }, action: "edit", resources: [join(directory, "design", "**")],
        }, context.signal);
        context.signal.throwIfAborted();
        return { content: await runDesignSystemTool(directory, params) };
      }),
    });
  });

  await ctx.command.transform((editor) => editor.add({
    name: "design", description: DESIGN_HELP,
    execute: async ({ sessionID, prompt, delivery }) => exclusive(sessionID, async () => {
      const { directory, canvas } = await entryFor(sessionID);
      const args = parseDesignArgs(prompt.text);
      const notify = async (text: string) => { await ctx.session.synthetic({ sessionID, text, resume: false }); };
      if (args.kind === "usage") {
        if (listDesigns(directory).length || hasSystemBoard(directory)) {
          await permission({ sessionID, action: DESIGN_TOOL_NAME, resources: [join(directory, "design", "**")] });
          await notify((await canvas.open(directory)).message);
        } else await notify(designUsage([]));
        return;
      }
      if (args.kind === "brief" || args.name === "sync") {
        if (args.kind === "subcommand" && args.rest) throw new Error("/design sync takes no arguments.");
        await ctx.session.prompt({
          ...prompt, sessionID, delivery,
          text: args.kind === "brief" ? args.brief : DESIGN_SYNC_REQUEST,
          skills: [...(prompt.skills ?? []).filter((item) => item.id !== skillID), { id: skillID }],
        });
        return;
      }
      if (args.name === "implement") {
        const plan = await planDesignImplement(directory, args.rest);
        if (plan.kind === "refuse") { await notify(plan.notice.message); return; }
        await permission({ sessionID, action: "edit", resources: [join(directory, "design", "**")] });
        await sendDesignImplement(directory, plan, (text) => deliver(sessionID, directory, text));
        await notify(`Implementation handoff queued: ${args.rest}`);
        return;
      }
      await permission({ sessionID, action: DESIGN_TOOL_NAME, resources: [join(directory, "design", "**")] });
      if (args.name === "stop") await notify(await canvas.stop() ? "Design canvas stopped." : "No design canvas is running.");
      else await notify((await canvas.open(directory, args.rest || undefined)).message);
    }),
  }));

  // Closing a terminal tab is not session shutdown: the shared service still owns it.
  // Explicit stop, session move/deletion, and plugin unload release the server.
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ types: ["session.deleted", "session.moved"], signal: controller.signal })) {
      await exclusive(event.data.sessionID, () => stop(event.data.sessionID));
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) console.error("[opencode-design] lifecycle subscription ended", error);
  });

  return async () => {
    disposed = true;
    controller.abort();
    await Promise.allSettled([...pending]);
    await Promise.allSettled([...entries.keys()].map(stop));
    await events;
  };
}
