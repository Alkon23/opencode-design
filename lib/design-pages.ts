import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { locateDesignFile, locateRootFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

export type DesignPageRequest = { id: string; slug: string; parent: { slug: string; file: string }; brief: string; count: number; sent: boolean };
const FILE = "page-requests.json";
export const PAGE_REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const reservedSlug = (id: string) => `page-${id.toLowerCase().replaceAll("_", "-")}`;

function validRecord(value: unknown): value is DesignPageRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as DesignPageRequest;
  const slug = (s: unknown) => typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s);
  return typeof r.id === "string" && PAGE_REQUEST_ID.test(r.id) && slug(r.slug) && r.slug === reservedSlug(r.id)
    && typeof r.sent === "boolean" && typeof r.brief === "string" && r.brief.trim().length > 0 && r.brief.length <= 4000
    && !!r.parent && slug(r.parent.slug) && r.parent.slug !== r.slug && typeof r.parent.file === "string" && /^[^\\:]+\.html$/i.test(r.parent.file)
    && r.parent.file.split("/").every((part) => part && !part.startsWith(".") && !/[\x00-\x1f]/.test(part))
    && Number.isInteger(r.count) && r.count >= 3 && r.count <= 12;
}

/** New records only. The request and reserved child identity survive ambiguous admission. */
export async function sendDesignPage(root: string, input: Omit<DesignPageRequest, "slug" | "sent">, deliver: (request: DesignPageRequest) => Promise<unknown>): Promise<DesignPageRequest> {
  const directory = await realpath(root);
  return serializeDesignWrite(join(directory, ".page-request-delivery"), async () => {
    const target = await locateRootFile(directory, FILE);
    const raw = await readDesignFile(target.path, 4 * 1024 * 1024, () => new Error("Page request history is too large"));
    let document: { version: number; requests: DesignPageRequest[] };
    try {
      document = raw === undefined ? { version: 1, requests: [] } : JSON.parse(raw);
      if (document.version !== 1 || !Array.isArray(document.requests) || document.requests.length > 500 || document.requests.some((r) => !validRecord(r)) || new Set(document.requests.map((r) => r.id)).size !== document.requests.length) throw new Error();
    } catch { throw new Error("Invalid page-requests.json; repair it explicitly, never overwrite it"); }
    let request = document.requests.find((r) => r.id === input.id);
    if (request && JSON.stringify([request.parent, request.brief, request.count]) !== JSON.stringify([input.parent, input.brief, input.count])) throw new PageRequestConflict();
    const save = () => replaceDesignFile(target.dir, target.path, FILE, JSON.stringify(document, null, 2) + "\n");
    if (!request) {
      if (document.requests.length >= 500) throw new Error("Page request history is full");
      const slug = reservedSlug(input.id);
      // Exclusive mkdir never adopts or overwrites an unrelated design or symlink.
      await mkdir(join(directory, slug));
      request = { ...input, slug, sent: false };
      document.requests.push(request);
      await save();
    }
    if (request.sent) return request;
    if (await realpath(join(directory, request.slug)) !== join(directory, request.slug)) throw new Error("Reserved child directory must not be redirected");
    // Create the manifest only once; retries never replace generated proposal work.
    const child = await locateDesignFile(directory, request.slug, "design.json", (message) => new Error(message));
    const manifestRaw = await readDesignFile(child.path, 1024 * 1024, () => new Error("Child manifest is too large"));
    if (manifestRaw === undefined) {
      await replaceDesignFile(child.dir, child.path, "design.json", JSON.stringify({ title: request.brief.slice(0, 80), brief: request.brief, parent: request.parent, requestId: request.id, artboards: [] }, null, 2) + "\n");
    } else {
      const manifest = JSON.parse(manifestRaw);
      if (manifest?.requestId !== request.id || manifest?.parent?.slug !== request.parent.slug || manifest?.parent?.file !== request.parent.file) throw new Error("Reserved child manifest identity changed; refusing generation");
    }
    await deliver(request);
    request.sent = true;
    await save();
    return request;
  });
}

export class PageRequestConflict extends Error {}

export function designPagePrompt(request: DesignPageRequest): string {
  return [
    `Create ${request.count} distinct new-page proposals in design/${request.slug}/ using design/${request.parent.slug}/${request.parent.file} as the base/reference.`,
    `Request id: ${request.id}`, "", "New page details (user brief):", request.brief, "",
    "Read the referenced proposal HTML, its design.json brief, applicable comments/preferences, and design/system.md before designing.",
    "Preserve the app's visual language, similar structure, shared headers and footers, navigation, components, conventions, typography, spacing, preferences and effective preview tokens. Vary the new page's layout/content strategy without inventing a different app identity.",
    "Leave the base proposal, sibling designs, and application source files unchanged. Follow the opencode-design skill; create self-contained responsive HTML proposals with meaningful tradeoffs.",
    `Update the reserved design/${request.slug}/design.json with the generated artboards. Keep parent ${JSON.stringify(request.parent)} and requestId ${JSON.stringify(request.id)} exactly. Never create a second child design for this request.`,
    `Create at least ${request.count} proposals. Refresh design_canvas action open with slug ${JSON.stringify(request.slug)}; the canvas connects this page's proposals to their base.`,
  ].join("\n");
}
