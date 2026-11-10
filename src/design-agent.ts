import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type Plugin } from "@opencode/plugin";

export const DESIGN_AGENT_ID = "design";
export const designAgentPath = fileURLToPath(new URL("../agents/design.md", import.meta.url));

/** JSON is valid YAML frontmatter and keeps one source for the bundled policy. */
export async function loadDesignAgent() {
  const document = await readFile(designAgentPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(document);
  if (!match) throw new Error("Invalid bundled Design agent");
  const definition = JSON.parse(match[1]) as {
    description: string; mode: "primary"; permissions: Agent.Info["permissions"];
  };
  return { ...definition, system: match[2].trim() };
}

export async function registerDesignAgent(ctx: Plugin.Context) {
  const definition = await loadDesignAgent();
  await ctx.agent.transform(editor => {
    // Do not replace a user's custom agent or change the session/default agent.
    if (editor.get(DESIGN_AGENT_ID)) return;
    editor.update(DESIGN_AGENT_ID, agent => {
      agent.name = Agent.Name.make("Design");
      agent.description = definition.description;
      agent.mode = definition.mode;
      agent.system = definition.system;
      agent.permissions = [
        ...definition.permissions,
        // Canvas tools check absolute resources; builtin edits use relative paths.
        { action: "edit", resource: join(ctx.location.directory, ".spec", "*.md"), effect: "allow" },
        { action: "edit", resource: join(ctx.location.directory, ".design", "*"), effect: "allow" },
      ];
    });
  });
}
