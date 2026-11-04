import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { locateRootFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

export const SYSTEM_SOURCE_FILE = "system-source.json";
export const SYSTEM_OVERRIDES_FILE = "system-overrides.json";
export const TOKEN_GROUPS = ["color", "font", "spacing", "radius", "shadow", "component"] as const;
export type TokenGroup = typeof TOKEN_GROUPS[number];
export type SystemToken = { key: string; group: TokenGroup; value: string; source: string };
export type SystemOverride = { key: string; group: TokenGroup; value: string; sourceValue: string; sourcePath: string; reason?: string };
export type SystemSource = { version: 1; tokens: SystemToken[] };
export type SystemOverrides = { version: 1; overrides: SystemOverride[] };
export type EffectiveToken = SystemToken & { overridden: boolean; sourceValue: string };
export type SystemState = {
  source: SystemSource; overrides: SystemOverrides; tokens: EffectiveToken[];
  warnings: string[]; sourceExists: boolean; overridesExist: boolean;
};
const MAX_BYTES = 1024 * 1024;

function text(value: unknown, name: string, max = 1000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) throw new Error(`Invalid ${name}`);
}
function token(value: unknown): asserts value is SystemToken {
  if (!value || typeof value !== "object") throw new Error("Invalid system token");
  const item = value as Record<string, unknown>;
  text(item.key, "token key", 150);
  if (!/^[a-zA-Z0-9][\w.:-]*$/.test(item.key)) throw new Error("Token key must be a stable identifier");
  if (!TOKEN_GROUPS.includes(item.group as TokenGroup)) throw new Error("Invalid token group");
  text(item.value, "token value");
  text(item.source, "token source", 512);
  if (item.source !== "proposed" && (/^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)|^[a-z]+:/i.test(item.source))) throw new Error("Token source must be project-relative, or proposed for an approved starter");
}
function parse(raw: string, name: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`design/${name} is invalid JSON; repair it explicitly, never overwrite it`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: number }).version !== 1) throw new Error(`Invalid design/${name} document`);
  return value as Record<string, unknown>;
}
async function readRoot(root: string, name: string): Promise<string | undefined> {
  try {
    const { path } = await locateRootFile(root, name);
    return await readDesignFile(path, MAX_BYTES, () => new Error(`design/${name} is too large`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function unique<T extends { key: string }>(items: T[]): T[] {
  if (items.length > 1000 || new Set(items.map((t) => t.key)).size !== items.length) throw new Error("System token keys must be unique (maximum 1000)");
  return items;
}

/** Reading state never writes derived files or silently repairs malformed artifacts. */
export async function readSystemState(root: string): Promise<SystemState> {
  const sourceRaw = await readRoot(root, SYSTEM_SOURCE_FILE);
  const overrideRaw = await readRoot(root, SYSTEM_OVERRIDES_FILE);
  const source: SystemSource = { version: 1, tokens: [] };
  const overrides: SystemOverrides = { version: 1, overrides: [] };
  if (sourceRaw !== undefined) {
    const items = parse(sourceRaw, SYSTEM_SOURCE_FILE).tokens;
    if (!Array.isArray(items)) throw new Error("Invalid system-source.json tokens");
    source.tokens = unique(items.map((item: unknown) => { token(item); return { key: item.key, group: item.group, value: item.value, source: item.source }; }));
  }
  if (overrideRaw !== undefined) {
    const items = parse(overrideRaw, SYSTEM_OVERRIDES_FILE).overrides;
    if (!Array.isArray(items)) throw new Error("Invalid system-overrides.json overrides");
    overrides.overrides = unique(items.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid system override");
      const entry = item as SystemOverride;
      token({ ...entry, source: entry.sourcePath });
      text(entry.sourceValue, "override source value");
      if (entry.reason !== undefined) text(entry.reason, "override reason");
      return { key: entry.key, group: entry.group, value: entry.value, sourceValue: entry.sourceValue, sourcePath: entry.sourcePath, ...(entry.reason ? { reason: entry.reason } : {}) };
    }));
  }
  return { ...reconcileSystem(source, overrides), source, overrides, sourceExists: sourceRaw !== undefined, overridesExist: overrideRaw !== undefined };
}

export function reconcileSystem(source: SystemSource, overrides: SystemOverrides): Pick<SystemState, "tokens" | "warnings"> {
  const warnings: string[] = [];
  const byKey = new Map(source.tokens.map((item) => [item.key, item]));
  const active = new Map<string, SystemOverride>();
  for (const item of overrides.overrides) {
    const original = byKey.get(item.key);
    if (!original) warnings.push(`${item.key}: source token is missing; override preserved but inactive`);
    else if (original.group !== item.group) warnings.push(`${item.key}: source token group changed; override preserved but incompatible and inactive`);
    else {
      active.set(item.key, item);
      if (original.value !== item.sourceValue || original.source !== item.sourcePath) warnings.push(`${item.key}: source changed since approval; preview override retained, review it`);
    }
  }
  return { warnings, tokens: source.tokens.map((item) => ({ ...item, sourceValue: item.value, value: active.get(item.key)?.value ?? item.value, overridden: active.has(item.key) })) };
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function render(source: SystemSource, overrides: SystemOverrides): { markdown: string; html: string } {
  const { tokens, warnings } = reconcileSystem(source, overrides);
  const markdown = ["# Preview design system", "", "Generated from system-source.json + system-overrides.json. Overrides are preview-only; application sources are unchanged.", "",
    ...tokens.flatMap((t) => [`## ${t.key} (${t.group})`, `- Effective value: ${JSON.stringify(t.value)}`, `- Source: ${t.source === "proposed" ? "approved starter proposal" : t.source}`, `- Source value: ${JSON.stringify(t.sourceValue)}`, `- Preview override: ${t.overridden ? "yes" : "no"}`, ""]),
    ...(warnings.length ? ["## Review warnings", ...warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
  const cards = tokens.map((t) => {
    // Values are rendered as text. Only safe color/font/size literals reach a CSS preview.
    let style = "";
    if (t.group === "color" && /^(#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([\d\s.,%/+-]+\))$/i.test(t.value)) style = `background:${t.value}`;
    if (t.group === "font" && /^[\w\s,'"-]+$/.test(t.value)) style = `font-family:${t.value}`;
    if ((t.group === "spacing" || t.group === "radius") && /^\d+(\.\d+)?(px|rem|em)$/.test(t.value)) style = t.group === "spacing" ? `height:${t.value}` : `border-radius:${t.value}`;
    return `<section><h2>${escape(t.key)}</h2><p>${escape(t.group)} · ${t.overridden ? "Preview override" : "Source"}</p><div class="sample" style="${escape(style)}">${t.group === "font" ? "Aa — Preview typography" : ""}</div><code>${escape(t.value)}</code><p>Source: ${escape(t.source)}${t.overridden ? ` · original ${escape(t.sourceValue)}` : ""}</p></section>`;
  }).join("\n");
  return { markdown, html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preview design system</title><style>body{font-family:system-ui;background:#f6f7fb;color:#172033;margin:0;padding:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}section{background:white;border:1px solid #ccd2de;border-radius:12px;padding:20px;overflow-wrap:anywhere}.sample{min-height:24px;max-height:160px;background:#e3e8f2;margin:12px 0}h2{font-size:18px}code{white-space:pre-wrap}</style><body><h1>Preview design system</h1><p>Source tokens + preview overrides. Application styles are unchanged.</p>${warnings.map((w) => `<p role="status">${escape(w)}</p>`).join("")}<main>${cards}</main></body></html>` };
}

export type SystemToolParams = { action: "list" | "sync" | "set" | "remove"; tokens?: SystemToken[]; key?: string; value?: string; reason?: string };

/** Mutations touch only the four design/ artifacts; source files are never written. */
export async function runDesignSystemTool(cwd: string, params: SystemToolParams): Promise<string> {
  const root = join(cwd, "design");
  if (params.action === "list") return describe(await readSystemState(root));
  if (!["sync", "set", "remove"].includes(params.action)) throw new Error("Unknown design system action");
  await mkdir(root, { recursive: true });
  const { dir } = await locateRootFile(root, SYSTEM_SOURCE_FILE);
  return serializeDesignWrite(join(dir, ".system-artifacts"), async () => {
    const state = await readSystemState(root);
    if (params.action !== "sync" && !state.sourceExists) throw new Error("Sync the source tokens before changing overrides");
    if (params.action === "sync") {
      if (!Array.isArray(params.tokens)) throw new Error("sync requires the extracted token list");
      params.tokens.forEach(token);
      state.source = { version: 1, tokens: unique(params.tokens.map((t) => ({ key: t.key, group: t.group, value: t.value, source: t.source }))) };
    } else {
      text(params.key, "token key", 150);
      if (params.action === "set") {
        text(params.value, "override value");
        if (params.reason !== undefined) text(params.reason, "override reason");
        const original = state.source.tokens.find((t) => t.key === params.key);
        if (!original) throw new Error("Sync the source token first; cannot override an unknown token");
        state.overrides.overrides = state.overrides.overrides.filter((t) => t.key !== params.key);
        state.overrides.overrides.push({ key: original.key, group: original.group, value: params.value, sourceValue: original.value, sourcePath: original.source, ...(params.reason ? { reason: params.reason } : {}) });
      } else state.overrides.overrides = state.overrides.overrides.filter((t) => t.key !== params.key);
    }
    unique(state.overrides.overrides);
    const output = render(state.source, state.overrides);
    const artifacts: Array<[string, string]> = [
      [SYSTEM_SOURCE_FILE, JSON.stringify(state.source, null, 2) + "\n"],
      [SYSTEM_OVERRIDES_FILE, JSON.stringify(state.overrides, null, 2) + "\n"],
      ["system.md", output.markdown], ["system.html", output.html],
    ];
    // Preflight every target before any write, including derived output symlinks.
    for (const [name] of artifacts) await locateRootFile(root, name);
    for (const [name, content] of artifacts) {
      if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`design/${name} is too large`);
    }
    for (const [name, content] of artifacts) {
      // An override change must not reset source-extraction freshness.
      if (name === SYSTEM_SOURCE_FILE && params.action !== "sync") continue;
      await replaceDesignFile(dir, join(dir, name), name, content);
    }
    return describe(await readSystemState(root)) + "\nRefresh all affected proposal previews using the effective tokens; do not modify application sources.";
  });
}
function describe(state: SystemState): string {
  return JSON.stringify({ sourceFile: `design/${SYSTEM_SOURCE_FILE}`, sourceExists: state.sourceExists, overridesFile: `design/${SYSTEM_OVERRIDES_FILE}`, overrides: state.overrides.overrides, effectiveTokens: state.tokens, warnings: state.warnings }, null, 2);
}
