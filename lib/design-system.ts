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
const GROUP_LABELS: Record<TokenGroup, string> = { color: "Colors", font: "Typography", spacing: "Spacing", radius: "Radii", shadow: "Shadows", component: "Components" };
const colorLiteral = /^(#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([\d\s.,%/+-]+\))$/i;
const sizeLiteral = /^\d+(\.\d+)?(px|rem|em)$/;
const palette = (key: string) => /^(light|dark)[.:-]/i.exec(key)?.[1].toLowerCase() ?? "shared";
const role = (key: string) => key.replace(/^(light|dark)[.:-]/i, "");
const missing = '<p class="empty">Not specified in the supplied source snapshot. Re-sync after inspecting the project sources; no value has been invented.</p>';

/** Display labels only: persisted keys remain the authority for overrides and annotations. */
function foundationLabel(t: SystemToken): string {
  const prefixes: Record<TokenGroup, string> = { color: "color|colors", font: "font|fonts|typography", spacing: "spacing|space", radius: "radius|radii", shadow: "shadow|shadows", component: "component|components" };
  let key = t.key.replace(new RegExp(`^(?:${prefixes[t.group]})[.:-]`, "i"), "");
  const variant = /[.:](compact|comfortable|dense|relaxed|default)$/i.exec(key)?.[1];
  if (variant) key = key.slice(0, -(variant.length + 1));
  let words = key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[._:-]+/g, " ").trim().toLowerCase();
  if (t.group === "font") {
    const metrics = { "line height": "line height", "letter spacing": "letter spacing", "font family": "font family", family: "font family", size: "text size", weight: "weight", tracking: "letter spacing" };
    for (const [metric, name] of Object.entries(metrics)) {
      const subject = words.startsWith(`${metric} `) ? words.slice(metric.length + 1)
        : words.endsWith(` ${metric}`) ? words.slice(0, -(metric.length + 1)) : "";
      if (subject) { words = `${subject} ${name}`; break; }
    }
  }
  const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  return sentence(words || key || t.key) + (variant ? ` · ${sentence(variant.toLowerCase())}` : "");
}

function tokenDetails(t: EffectiveToken): string {
  return `<div class="token-meta"><span class="badge${t.overridden ? " override" : ""}">${t.overridden ? "Preview override" : "Source"}</span><code>${escape(t.value)}</code><small>Source: ${escape(t.source === "proposed" ? "approved starter proposal" : t.source)}${t.overridden ? ` · original ${escape(t.sourceValue)}` : ""}</small></div>`;
}

/** Typed, literal-only previews: token text never becomes arbitrary CSS or markup. */
function foundationCard(t: EffectiveToken): string {
  let style = "", sample = "", kind = "sample", label = "";
  if (t.group === "font") {
    sample = "The quick brown fox · Aa 0123";
    if (/line[.-]?height/i.test(t.key) && /^(\d+(\.\d+)?|\d+(\.\d+)?(px|rem|em|%))$/.test(t.value)) { style = `line-height:${t.value}`; label = "Line height"; sample += "<br>Readable rhythm across lines."; }
    else if (/weight/i.test(t.key) && /^(normal|bold|[1-9]\d{0,2}|1000)$/.test(t.value)) { style = `font-weight:${t.value}`; label = "Weight"; }
    else if (/(letter[.-]?spacing|tracking)/i.test(t.key) && /^-?\d+(\.\d+)?(px|rem|em)$/.test(t.value)) { style = `letter-spacing:${t.value}`; label = "Letter spacing"; }
    else if (sizeLiteral.test(t.value)) { style = `font-size:${t.value}`; label = "Size"; }
    else if (/^[a-zA-Z][\w\s,'"-]*$|^['"][\w\s,'"-]+$/.test(t.value)) { style = `font-family:${t.value}`; label = "Font family"; }
    if (!style) sample = "";
    kind = "type-sample";
  } else if (t.group === "spacing" && sizeLiteral.test(t.value)) { style = `width:${t.value}`; kind = "spacing-sample"; }
  else if (t.group === "radius" && (sizeLiteral.test(t.value) || /^\d+(\.\d+)?%$/.test(t.value))) { style = `border-radius:${t.value}`; kind = "radius-sample"; }
  else if (t.group === "shadow" && /^(none|(?:inset\s+)?(?:-?\d+(?:\.\d+)?(?:px|rem|em)?\s+){2,4}(?:#[\da-f]{3,8}|rgba?\([\d\s.,%/]+\)))$/i.test(t.value)) { style = `box-shadow:${t.value}`; kind = "shadow-sample"; }
  else if (t.group === "component") sample = escape(t.value);
  const preview = style || sample ? `<div class="${kind}" style="${escape(style)}">${sample}</div>` : '<p class="empty">Value listed below; no literal visual preview available.</p>';
  return `<article class="foundation-card" data-token-key="${escape(t.key)}"><h3>${escape(foundationLabel(t))}</h3>${label ? `<p class="eyebrow">${label}</p>` : ""}${preview}${tokenDetails(t)}<details class="token-details"><summary>Token key</summary><code>${escape(t.key)}</code></details></article>`;
}

function render(source: SystemSource, overrides: SystemOverrides): { markdown: string; html: string } {
  const { tokens, warnings } = reconcileSystem(source, overrides);
  const grouped = (group: TokenGroup) => tokens.filter((t) => t.group === group);
  const markdown = ["# Preview design system", "", "Generated from system-source.json + system-overrides.json. Overrides are preview-only; application sources are unchanged.", "",
    ...TOKEN_GROUPS.flatMap((group) => [`## ${GROUP_LABELS[group]}`, "", ...(grouped(group).length ? grouped(group).flatMap((t) => [`### ${t.key}`, `- Effective value: ${JSON.stringify(t.value)}`, `- Source: ${t.source === "proposed" ? "approved starter proposal" : t.source}`, `- Source value: ${JSON.stringify(t.sourceValue)}`, `- Preview override: ${t.overridden ? "yes" : "no"}`, ""]) : ["Not specified in the supplied source snapshot.", ""])]),
    ...(warnings.length ? ["## Review warnings", ...warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
  const colors = grouped("color");
  const roles = [...new Set(colors.filter((t) => palette(t.key) !== "shared").map((t) => role(t.key)))].sort();
  const colorCard = (t: EffectiveToken) => `<article class="color-card" data-token-key="${escape(t.key)}"><div class="swatch"${colorLiteral.test(t.value) ? ` style="background:${escape(t.value)}"` : ""}></div><div><h4>${escape(role(t.key))}</h4>${tokenDetails(t)}</div></article>`;
  const palettes = ["light", "dark"].map((mode) => {
    const items = colors.filter((t) => palette(t.key) === mode);
    return `<section class="palette ${mode}" data-palette="${mode}"><h3>${mode === "light" ? "Light" : "Dark"}</h3><p class="palette-caption">${items.length} color tokens</p>${items.length ? roles.map((key) => { const t = items.find((item) => role(item.key) === key); return t ? colorCard(t) : `<article class="color-card absent"><h4>${escape(key)}</h4><p>Not specified for this theme</p></article>`; }).join("") : missing}</section>`;
  }).join("");
  const shared = colors.filter((t) => palette(t.key) === "shared");
  const sections = TOKEN_GROUPS.filter((group) => group !== "color").map((group) => `<section class="foundation" id="${group}"><h2>${GROUP_LABELS[group]}</h2>${grouped(group).length ? `<div class="foundation-grid">${grouped(group).map(foundationCard).join("")}</div>` : missing}</section>`).join("");
  const detailCss = ".token-details{margin-top:14px;font-size:11px;color:#626e72}.token-details summary{cursor:pointer}.token-details code{display:block;margin-top:6px}";
  const css = `*{box-sizing:border-box}body{margin:0;padding:40px;background:#f5f4f0;color:#202b31;font:15px/1.5 system-ui,sans-serif}header,main{max-width:1320px;margin:auto}header{padding-bottom:28px;border-bottom:1px solid #d7dad7}h1{font-size:36px;letter-spacing:-.04em;margin:4px 0 10px}h2{font-size:24px;letter-spacing:-.025em;margin:0 0 20px}h3,h4,p{margin:0 0 8px}h3{font-size:19px}h4{font-size:15px}nav{display:flex;gap:18px;flex-wrap:wrap;margin-top:20px}a{color:inherit;text-underline-offset:4px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#626e72}.foundation{margin-top:40px}.palettes{display:grid;grid-template-columns:1fr 1fr;gap:24px}.palette{padding:24px;border:1px solid #d5d9d6;border-radius:16px;min-width:0}.light{background:#fffefa;color:#202b31}.dark{background:#1b2228;color:#eff1ef;border-color:#354149}.palette-caption{opacity:.7;margin-bottom:24px}.color-card{display:grid;grid-template-columns:72px minmax(0,1fr);gap:16px;align-items:center;min-height:154px;border-top:1px solid #8b969440;padding:16px 0}.swatch{height:72px;border-radius:12px;border:1px solid #8b969460;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0/16px 16px}.absent{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;opacity:.7}.token-meta{display:flex;flex-direction:column;gap:5px;min-width:0}.badge{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.75}.override{color:#9b5800;opacity:1}.dark .override{color:#ffcb83}code{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}small{font-size:11px;opacity:.72;overflow-wrap:anywhere}.foundation-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.foundation-card{background:#fff;border:1px solid #d5d9d6;border-radius:12px;padding:20px;min-width:0;overflow:hidden}.foundation-card h3{font-size:15px}.sample,.type-sample{margin:20px 0;overflow:auto;max-height:180px;overflow-wrap:anywhere}.type-sample{font-size:24px}.spacing-sample{height:20px;max-width:100%;background:#43766d;margin:24px 0}.radius-sample,.shadow-sample{width:104px;height:72px;background:#e4ece7;margin:24px auto}.radius-sample{border:1px solid #82998b}.empty{padding:16px;border:1px dashed #8b969470;border-radius:8px;font-size:13px}.notice{padding:14px 18px;border-left:3px solid #ad7730;background:#fff2da;margin-top:16px}.shared-colors{margin-top:24px}@media(max-width:700px){body{padding:20px}.palettes{grid-template-columns:1fr}.palette{padding:18px}h1{font-size:28px}}`;
  return { markdown, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview design system</title><style>${css}${detailCss}</style></head><body><header><p class="eyebrow">Design foundations</p><h1>Preview design system</h1><p>Source tokens + preview overrides. Application styles are unchanged.</p><nav aria-label="Design foundations">${TOKEN_GROUPS.map((g) => `<a href="#${g}">${GROUP_LABELS[g]}</a>`).join("")}</nav></header><main>${warnings.map((w) => `<p class="notice" role="status">${escape(w)}</p>`).join("")}<section class="foundation" id="color"><h2>Colors</h2><div class="palettes">${palettes}</div>${shared.length ? `<section class="shared-colors"><h3>Shared / unthemed</h3><div class="foundation-grid">${shared.map(colorCard).join("")}</div></section>` : ""}</section>${sections}</main></body></html>` };
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
  return JSON.stringify({ sourceFile: `design/${SYSTEM_SOURCE_FILE}`, sourceExists: state.sourceExists, overridesFile: `design/${SYSTEM_OVERRIDES_FILE}`, overrides: state.overrides.overrides, effectiveTokens: state.tokens, missingGroups: TOKEN_GROUPS.filter((group) => !state.tokens.some((token) => token.group === group)), coverageNote: "Missing groups are not specified in this snapshot. Inspect all design sources during sync; do not invent extracted values.", warnings: state.warnings }, null, 2);
}
