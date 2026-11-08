import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type Plugin } from "@opencode/plugin";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadDesignAgent, registerDesignAgent } from "../src/design-agent.ts";

function registry(existing?: Agent.Info) {
  const agents = new Map<string, Agent.Info>(existing ? [["design", existing]] : []);
  const directory = process.cwd();
  let writes = 0;
  const ctx = {
    location: { directory },
    agent: { transform: async (callback: (editor: {
      get(id: string): Agent.Info | undefined;
      update(id: string, update: (agent: Agent.Info) => void): void;
    }) => void) => callback({
      get: id => agents.get(id),
      update: (id, update) => {
        writes++;
        const agent = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id));
        update(agent); agents.set(id, agent);
      },
    }) },
  } as unknown as Plugin.Context;
  return { ctx, directory, agents, writes: () => writes };
}

test("bundled Design contract gates visual design and captures all selected targets into linked specifications", async () => {
  const definition = await loadDesignAgent();
  assert.equal(definition.mode, "primary");
  for (const phrase of ["spec/APP.md", "every feature specification", "read all linked feature files",
    "Are all technical and design details provided, and may I start the UI design process?",
    "Wait for an explicit affirmative answer", "Read **every selected target**", "../design/<slug>/<artboard>.html",
    "implementation not started", "Do not call `design_canvas`", "Never report `handoff` status"]) {
    assert.ok(definition.system.includes(phrase), `Missing contract: ${phrase}`);
  }
});

test("Design registration preserves collisions and does not select a default agent", async () => {
  const custom = { ...Agent.Info.default(Agent.ID.make("design")), system: "User's custom agent" };
  const existing = registry(custom);
  await registerDesignAgent(existing.ctx);
  assert.equal(existing.writes(), 0);
  assert.equal(existing.agents.get("design"), custom);
  const fresh = registry();
  await registerDesignAgent(fresh.ctx);
  assert.equal(fresh.writes(), 1);
  assert.equal(fresh.agents.get("design")!.name, "Design");
  await registerDesignAgent(fresh.ctx);
  assert.equal(fresh.writes(), 1, "repeat registration leaves existing definition alone");
});

test("Design startup distinguishes external palette provenance from sync token sources", async () => {
  const { system } = await loadDesignAgent();
  for (const phrase of ["project-relative", 'source: "proposed"', "external reference", "spec/APP.md",
    "original path and line range", "Do not invent a local source path", "palette approval"]) {
    assert.ok(system.includes(phrase), `Missing external-source instruction: ${phrase}`);
  }
  const workflow = await readFile(new URL("../skills/design/references/workflow.md", import.meta.url), "utf8");
  assert.match(workflow, /D:\/reference\/styles\.css/);
  assert.match(workflow, /not.*Tailwind.*dependenc/i);
});

test("Design startup branches on existing designs before querying slug-specific comments", async () => {
  const { system } = await loadDesignAgent();
  for (const phrase of ["New slug", "Existing slug", "Do not call `design_comments` for a new slug",
    "manifest and proposal files", "confirm the slug", "wrong session directory"]) {
    assert.ok(system.includes(phrase), `Missing startup instruction: ${phrase}`);
  }
  const skill = await readFile(new URL("../skills/design/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Do not query comments for a new slug/);
});

test("Design permission boundary allows only specs and previews to be edited", async () => {
  const h = registry();
  await registerDesignAgent(h.ctx);
  const rules = h.agents.get("design")!.permissions;
  // Exercise the documented ordered wildcard semantics, including absolute
  // resources used by the canvas tools. Native host smoke also checks the policy.
  const effect = (action: string, resource: string) => rules.filter(rule => {
    const match = (pattern: string, value: string) => new RegExp(`^${pattern.replaceAll("\\", "/").split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, process.platform === "win32" ? "i" : "").test(value.replaceAll("\\", "/"));
    return match(rule.action, action) && match(rule.resource, resource);
  }).at(-1)?.effect;
  for (const file of ["spec/APP.md", "spec/billing.md", "design/page/01.html", join(h.directory, "spec", "billing.md"), join(h.directory, "design", "**")]) {
    assert.equal(effect("edit", file), "allow", file);
  }
  for (const file of ["src/app.ts", "package.json", "spec/implementation.ts", join(h.directory, "src", "app.ts"), join(h.directory, "..", "other", "spec", "APP.md")]) {
    assert.equal(effect("edit", file), "deny", file);
  }
  assert.equal(effect("shell", "npm install"), "deny");
  assert.equal(effect("subagent", "general"), "deny");
  assert.equal(effect("skill", "opencode-design"), "allow");
  assert.equal(effect("design_canvas", "*"), "allow");
});
