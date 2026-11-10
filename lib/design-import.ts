import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDesignWrite } from "./design-comments.ts";

export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** Resolve a local reference without reading it; the adapter authorizes before I/O. */
export function importFilePath(cwd: string, reference: string): string {
  let value = reference.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (/^["']/.test(value)) {
    if (value.at(-1) !== value[0]) throw new Error("Close the quoted HTML file path.");
    value = value.slice(1, -1);
  }
  if (!value || /[\x00-\x1f]/.test(value)) throw new Error("Usage: /design import <local-html-file>");
  if (/^file:/i.test(value)) value = fileURLToPath(value);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error("Import requires a local HTML file, not a URL.");
  const path = resolve(cwd, value);
  if (!/\.html?$/i.test(path)) throw new Error("Import requires an .html or .htm snapshot.");
  return path;
}

/** Copy the captured DOM, never regenerate it or load its dependencies. */
export async function importDesign(cwd: string, source: string) {
  const handle = await open(source, "r");
  let content: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMPORT_BYTES) throw new Error("HTML snapshot must be a nonempty regular file of at most 32 MiB.");
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_IMPORT_BYTES) throw new Error("HTML snapshot exceeds 32 MiB.");
    content = buffer.subarray(0, length);
  } finally { await handle.close(); }
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new Error("Export the HTML snapshot using UTF-8 encoding."); }
  if (!/<(?:!doctype\s+html|html|body|head)(?:\s|>)/i.test(html)) throw new Error("The file is not an HTML document. Export the rendered page, not the app source.");
  const warnings = ["Imported as a visual snapshot; login, backend requests and app behavior are not replayed."];
  const references = [
    ...html.matchAll(/\b(?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi),
    ...html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi),
  ].map(match => (match[1] ?? match[2] ?? match[3]).trim());
  if (references.some(value => value && !/^(?:data:|#|about:blank$)/i.test(value))) warnings.push("The snapshot may reference non-embedded resources. External resources remain blocked; export a self-contained page for faithful rendering.");
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh)\b/i.test(html)) warnings.push("The export contains a CSP or refresh meta tag which may prevent rendering or element comments. Re-export without page-specific policies/redirects if necessary; the canvas sandbox stays enforced.");
  const root = join(await realpath(cwd), "design");
  return serializeDesignWrite(root, async () => {
    try { await mkdir(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("design/ must be a real project directory, not a symbolic link.");
    const name = basename(source, extname(source));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "imported-page";
    let slug = base;
    for (let index = 2; ; index++) {
      try { await mkdir(join(root, slug)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        slug = `${base}-${index}`;
      }
    }
    const title = name.slice(0, 200) || "Imported page";
    await writeFile(join(root, slug, "01-original.html"), content, { flag: "wx" });
    // Publish the manifest last: partial imports never appear as ready designs.
    await writeFile(join(root, slug, "design.json"), JSON.stringify({
      title, brief: "Imported rendered app snapshot. Preserve its captured state and visual identity when designing changes.",
      importedFrom: { file: source, sha256: createHash("sha256").update(content).digest("hex"), importedAt: new Date().toISOString() },
      artboards: [{ file: "01-original.html", title: "Original snapshot", tradeoff: "Captured visual state; not a live app", width: 1440, height: 900 }],
    }, null, 2) + "\n", { flag: "wx" });
    return { slug, warnings };
  });
}
