import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { open, readFile, realpath, stat, lstat, rename, unlink, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_REQUEST_ID, PageRequestConflict, sendDesignPage, type DesignPageRequest } from "./design-pages.ts";
import { locateDesignFile, readDesignFile, replaceDesignFile } from "./design-comments.ts";
import { DESIGN_COMMENTS_FILE, SYSTEM_COMMENTS_FILE, DESIGN_COMMENT_LIMITS, DESIGN_SCREENSHOT_TYPES, DesignCommentsError, MAX_DESIGN_SCREENSHOT_BYTES, createDesignCommentStore, createSystemCommentStore, designCommentTarget, isDesignCommentId, serializeDesignWrite, truncateUtf16, type DesignCommentInput, type DesignCommentTarget, type StoredDesignComment } from "./design-comments.ts";
import { DesignHandoffsError, createDesignHandoffStore, sendDesignHandoff, type DesignHandoffDelivery } from "./design-handoffs.ts";
import { createDesignStatusStore, DESIGN_STATUS_FILE } from "./design-status.ts";

// Loopback canvas host. Every route lives under a
// per-server random token, the Host header must name this server, POSTs need
// this server's own Origin, and files resolve by realpath inside designRoot.

const HOST = "127.0.0.1";
/** Design directory names the canvas serves: kebab-case, never a dot or path segment. */
export const DESIGN_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SLUG = DESIGN_SLUG;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));
const ASSETS: Readonly<Record<string, string>> = Object.freeze({
	"canvas.js": "text/javascript; charset=utf-8",
	"request-status.js": "text/javascript; charset=utf-8",
	"canvas.css": "text/css; charset=utf-8",
	"inspector.js": "text/javascript; charset=utf-8",
});
const FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	// No font types: artboards use system font stacks (S1), and a sandboxed
	// artboard's opaque-origin font request would be refused anyway.
});
const LIMITS = Object.freeze({
	bodyBytes: 16 * 1024,
	/** POST api/comments may carry one base64 screenshot; its other fields keep `bodyBytes`. */
	commentBodyBytes: 8 * 1024 * 1024,
	...DESIGN_COMMENT_LIMITS,
	manifestBytes: 256 * 1024,
	fileBytes: 32 * 1024 * 1024,
	artboards: 64,
	artboardSide: 20000,
	sseClients: 16,
});
/** design/system.html, written by /design sync, is shown as the first board of every design. */
const SYSTEM_FILE = "system.html";
/** Root files whose changes reach the canvas as `{ slug: null, file }`. */
const SYSTEM_FILES: ReadonlySet<string> = new Set([SYSTEM_FILE, "system.md", SYSTEM_COMMENTS_FILE, "system-source.json", "system-overrides.json"]);
const SYSTEM_BOARD = Object.freeze({ width: 1440, height: 1200 });
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 15_000;
const BASE_HEADERS = Object.freeze({
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
});
// Canvas and API only: artboards run in an opaque origin, so their own
// subresources (files, inspector.js) would be blocked by a same-origin CORP.
const SAME_ORIGIN_ONLY = Object.freeze({ "Cross-Origin-Resource-Policy": "same-origin" });
const CANVAS_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	// Compare (S15) frames the running app next to its artboard: loopback origins only.
	`frame-src 'self' ${["http", "https"].flatMap((scheme) => ["localhost", "127.0.0.1", "[::1]"].map((host) => `${scheme}://${host}:*`)).join(" ")}`,
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

/**
 * A comment's screenshot as delivered to the session: `path` is relative to the
 * session cwd (design/<slug>/.screenshots/<id>.<ext>); `data` is base64, absent when unreadable.
 */
export type DesignCommentScreenshot = { path: string; mimeType: string; data?: string };

/** A comment as delivered to the session; `id` names it in design/<slug>/comments.json. */
export type DesignComment = DesignCommentTarget & { id: string; slug: string; comment: string; screenshot?: DesignCommentScreenshot };

/** Session message content: plain text, or text followed by the attached screenshots. */
export type DesignSessionContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/** The most screenshots one batch message attaches; later ones are named for the read tool. */
export const MAX_DESIGN_BATCH_IMAGES = 6;

export type DesignCanvasServerOptions = {
	sessionID?: string;
	/** Absolute `<session cwd>/design` directory. */
	designRoot: string;
	/** "Send now": one comment, already saved; a throw leaves it saved and unsent. */
	onComment: (comment: DesignComment) => void | Promise<void>;
	/** "Send all": every open unsent comment of one design, as one batch. */
	onComments?: (batch: DesignComment[]) => void | Promise<void>;
	/**
	 * "Implement this": an artboard of the manifest, already validated and recorded as handed off
	 * in handoffs.json. It answers whether the handoff was queued behind a busy agent; a throw
	 * takes the record back and answers 500.
	 */
	onImplement?: (request: DesignImplementRequest) => DesignHandoffDelivery | Promise<DesignHandoffDelivery>;
	onPage?: (request: DesignPageRequest) => Promise<unknown>;
	onImplementMany?: (targets: DesignImplementRequest[]) => DesignHandoffDelivery | Promise<DesignHandoffDelivery>;
	initialSlug?: string;
	randomToken?: () => string;
};

export type DesignCanvasServer = {
	url: string;
	port: number;
	token: string;
	close(): Promise<void>;
	/** Canvas pages with an open live-reload stream. */
	connectedClients(): number;
	/** Tells every connected page to show `slug` (null: the system-only view) and reload it; returns how many it reached. */
	show(slug: string | null): number;
};

export type DesignArtboard = { file: string; title: string; tradeoff: string; width: number; height: number };
export type DesignManifest = { slug: string; title: string; brief: string; artboards: DesignArtboard[]; parent?: { slug: string; file: string }; requestId?: string; warnings?: string[] };
export type DesignImplementRequest = { slug: string; file: string };

class HttpError extends Error {
	readonly status: number;
	readonly reason: string;
	readonly body: Record<string, unknown> | undefined;
	constructor(status: number, reason: string, body?: Record<string, unknown>) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.body = body;
	}
}

/** Store failures as HTTP: a broken comments.json is 422 and is never overwritten. */
function storeFailure(error: unknown): never {
	if (!(error instanceof DesignCommentsError)) throw error;
	if (error.code === "not-found") throw new HttpError(404, "not-found");
	if (error.code === "invalid-file") throw new HttpError(422, "invalid-comments", { error: "invalid-comments", reason: error.message });
	if (error.code === "limit") throw new HttpError(409, "too-many-comments", { error: "too-many-comments", reason: error.message });
	if (error.code === "invalid-input") throw new HttpError(400, "invalid-comment", { error: "invalid-comment", reason: error.message });
	throw new HttpError(500, "internal");
}

/** handoffs.json failures as HTTP: a broken file is 422 and is never overwritten. */
function handoffFailure(error: unknown): never {
	if (!(error instanceof DesignHandoffsError)) throw error;
	if (error.code === "not-found") throw new HttpError(404, "not-found");
	if (error.code === "invalid-file") throw new HttpError(422, "invalid-handoffs", { error: "invalid-handoffs", reason: error.message });
	if (error.code === "limit") throw new HttpError(409, "too-many-handoffs", { error: "too-many-handoffs", reason: error.message });
	throw new HttpError(400, "invalid-handoff", { error: "invalid-handoff", reason: error.message });
}

function resolveInstruction(slug: string, ids: readonly string[], system = false): string {
	const list = ids.map((id) => JSON.stringify(id)).join(", ");
	if (system) return `mark it resolved with the design_comments tool (action "resolve", scope "system", ids [${list}]) only after the override, system board and affected proposal previews have been updated.`;
	return `mark it resolved with the design_comments tool (action "resolve", slug "${slug}", ids [${list}]), or set its status to "resolved" in design/${slug}/${DESIGN_COMMENTS_FILE}.`;
}

function excerptLine(excerpt: string): string {
	return `Excerpt: ${excerpt ? JSON.stringify(excerpt) : "(none)"}`;
}

function screenshotLine(screenshot: DesignCommentScreenshot, attached: boolean): string {
	return `Screenshot: ${screenshot.path} (${attached ? "attached; open it with the read tool if you cannot see it" : "open it with the read tool"})`;
}

/** The batch comments whose screenshot is attached: readable ones, in order, up to the cap. */
function attachedScreenshots(batch: readonly DesignComment[]): Set<DesignComment> {
	return new Set(batch.filter((comment) => comment.screenshot?.data !== undefined).slice(0, MAX_DESIGN_BATCH_IMAGES));
}

function withImages(text: string, comments: Iterable<DesignComment>): DesignSessionContent {
	const images = [...comments].map((comment) => ({ type: "image" as const, data: comment.screenshot!.data!, mimeType: comment.screenshot!.mimeType }));
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}

/** Session content for one canvas comment: its message, with the screenshot attached when readable. */
export function designCommentContent(comment: DesignComment): DesignSessionContent {
	return withImages(formatDesignComment(comment), comment.screenshot?.data !== undefined ? [comment] : []);
}

/** Session content for a batch: one message, with up to MAX_DESIGN_BATCH_IMAGES screenshots attached. */
export function designCommentBatchContent(batch: readonly DesignComment[]): DesignSessionContent {
	return withImages(formatDesignCommentBatch(batch), attachedScreenshots(batch));
}

/** Session message for one canvas comment; paths are relative to the session cwd. */
export function formatDesignComment(comment: DesignComment): string {
	if (comment.scope === "system") return [
		"Design-system comment for design/system.html", "Scope: Design system (preview overrides only)", `Comment id: ${comment.id}`,
		...(comment.selector ? [`Element: ${comment.selector}`, excerptLine(comment.excerpt ?? "")] : []),
		...(comment.screenshot ? [screenshotLine(comment.screenshot, comment.screenshot.data !== undefined)] : []),
		"", "Comment:", comment.comment, "", systemCommentInstruction(), resolveInstruction("", [comment.id], true),
	].join("\n");
	if (comment.scope === "general") return [
		`General design comment for design/${comment.slug}`, "",
		`Design: ${comment.slug}`, "Scope: All proposals", `Comment id: ${comment.id}`,
		...(comment.screenshot ? [screenshotLine(comment.screenshot, comment.screenshot.data !== undefined)] : []),
		"", "Comment:", comment.comment, "", generalCommentInstruction(comment.slug),
		`When it is applied to all proposals, ${resolveInstruction(comment.slug, [comment.id])}`,
	].join("\n");
	const artboard = `design/${comment.slug}/${comment.file}`;
	return [
		`Design comment for ${artboard}`,
		"",
		`Design: ${comment.slug}`,
		`Artboard: ${artboard}`,
		`Comment id: ${comment.id}`,
		`Element: ${comment.selector}`,
		excerptLine(comment.excerpt),
		...(comment.screenshot ? [screenshotLine(comment.screenshot, comment.screenshot.data !== undefined)] : []),
		"",
		"Comment:",
		comment.comment,
		"",
		`Edit only the artboard ${artboard}, following the opencode-design skill.`,
		`When it is applied, ${resolveInstruction(comment.slug, [comment.id])}`,
	].join("\n");
}

function generalCommentInstruction(slug: string): string {
	return `Apply general comments to every proposal listed in design/${slug}/design.json, preserving each proposal's distinct approach. Do not change other designs or the design-system board. Resolve a general comment only after all proposals satisfy it.`;
}

export function systemCommentInstruction(): string {
	return "Follow the opencode-design skill's design-system feedback workflow. Use design_system list, then set or remove preview overrides in design/system-overrides.json. If a structured baseline is missing, read project sources and sync extracted tokens first, preserving existing overrides. The tool regenerates design/system.md and design/system.html; refresh affected proposals across design/ using effective tokens while preserving their approaches. Never edit application token/style/source files. Label overrides distinctly from extracted source values, flag missing/incompatible source tokens, and leave unresolved conflicts open.";
}

/** One session message for a batch of comments from one design. */
export function formatDesignCommentBatch(batch: readonly DesignComment[]): string {
	const slug = batch[0]?.slug ?? "";
	const system = batch[0]?.scope === "system";
	if (batch.some((c) => (c.scope === "system") !== system)) throw new Error("System and proposal delivery batches must be separate");
	const lines = [system ? `Design-system comments (${batch.length})` : `Design comments for design/${slug} (${batch.length})`, ""];
	const attached = attachedScreenshots(batch);
	batch.forEach((comment, index) => {
		lines.push(
			`${index + 1}. Comment id: ${comment.id}`,
			...(comment.scope === "system" ? ["   Scope: Design system (preview overrides only)", ...(comment.selector ? [`   Element: ${comment.selector}`, `   ${excerptLine(comment.excerpt ?? "")}`] : [])] : comment.scope === "general" ? ["   Scope: All proposals (general comment)"] : [
				`   Artboard: design/${comment.slug}/${comment.file}`,
				`   Element: ${comment.selector}`,
				`   ${excerptLine(comment.excerpt)}`,
			]),
			...(comment.screenshot ? [`   ${screenshotLine(comment.screenshot, attached.has(comment))}`] : []),
			"   Comment:",
			...comment.comment.split("\n").map((line) => `   ${line}`),
			"",
		);
	});
	lines.push(
		...(system ? [systemCommentInstruction()] : batch.some((comment) => comment.scope === "general") ? [
			"Follow the opencode-design skill. Element comments edit only their named artboard.", generalCommentInstruction(slug),
		] : ["Apply each comment following the opencode-design skill, editing only the artboard it names."]),
		`When a comment is applied, ${resolveInstruction(slug, batch.map((comment) => comment.id), system)}`,
	);
	return lines.join("\n");
}

function sameToken(expected: string, candidate: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(candidate);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** One decoded path segment, or null when it could name anything but a plain entry. */
function safeSegment(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new HttpError(400, "malformed-url");
	}
	if (decoded === "" || decoded.startsWith(".") || /[\/\\\0:]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
	return decoded;
}

/** Relative path such as `sub/01-a.html` split into plain segments, or null. */
function relativeSegments(value: unknown): string[] | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
	const parts = value.split("/");
	for (const part of parts) {
		if (part === "" || part.startsWith(".") || /[\\\0:]/.test(part) || /[\u0000-\u001f\u007f]/.test(part)) return null;
	}
	return parts;
}

function within(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES" || code === "EPERM";
}

function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeManifest(slug: string, raw: string): DesignManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new HttpError(422, "design.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(422, "design.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.title !== undefined && typeof record.title !== "string") throw new HttpError(422, "title must be a string");
	if (record.brief !== undefined && typeof record.brief !== "string") throw new HttpError(422, "brief must be a string");
	if (!Array.isArray(record.artboards)) throw new HttpError(422, "artboards must be an array");
	if (record.artboards.length > LIMITS.artboards) throw new HttpError(422, `artboards must have at most ${LIMITS.artboards} entries`);
	const artboards = record.artboards.map((entry: unknown, index: number): DesignArtboard => {
		const where = `artboards[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HttpError(422, `${where} must be an object`);
		const board = entry as Record<string, unknown>;
		if (board.discarded !== undefined && typeof board.discarded !== "boolean") throw new HttpError(422, `${where}.discarded must be a boolean`);
		const segments = relativeSegments(board.file);
		if (!segments || extname(segments[segments.length - 1]).toLowerCase() !== ".html") throw new HttpError(422, `${where}.file must be a relative .html path inside the design`);
		for (const key of ["title", "tradeoff"] as const) {
			if (board[key] !== undefined && typeof board[key] !== "string") throw new HttpError(422, `${where}.${key} must be a string`);
		}
		for (const key of ["width", "height"] as const) {
			const size = board[key];
			if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > LIMITS.artboardSide) throw new HttpError(422, `${where}.${key} must be an integer between 1 and ${LIMITS.artboardSide}`);
		}
		return {
			file: segments.join("/"),
			title: typeof board.title === "string" && board.title.trim() ? board.title.trim() : segments.join("/"),
			tradeoff: typeof board.tradeoff === "string" ? board.tradeoff.trim() : "",
			width: board.width as number,
			height: board.height as number,
		};
	}).filter((_, index) => !(record.artboards as Array<{ discarded?: boolean }>)[index].discarded);
	const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : slug;
	const manifest: DesignManifest = { slug, title, brief: typeof record.brief === "string" ? record.brief.trim() : "", artboards };
	if (record.parent !== undefined) {
		const parent = record.parent as Record<string, unknown> | null;
		if (!parent || typeof parent.slug !== "string" || !SLUG.test(parent.slug) || parent.slug === slug || !relativeSegments(parent.file) || extname(String(parent.file)).toLowerCase() !== ".html") throw new HttpError(422, "invalid parent proposal");
		manifest.parent = { slug: parent.slug, file: String(parent.file) };
	}
	if (record.requestId !== undefined) {
		if (typeof record.requestId !== "string" || !PAGE_REQUEST_ID.test(record.requestId)) throw new HttpError(422, "invalid requestId");
		manifest.requestId = record.requestId;
	}
	return manifest;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** JSON safe to place inside a `<script type="application/json">` element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function injectInspector(html: string, tag: string): string {
	const index = html.toLowerCase().lastIndexOf("</body>");
	return index === -1 ? html + tag : html.slice(0, index) + tag + html.slice(index);
}

function mediaType(req: IncomingMessage): string {
	return String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "body-too-large");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, "body-too-large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export type DesignListing = { slug: string; title: string; mtime: number; valid: boolean; parent?: { slug: string; file: string } };

/**
 * Designs under `designRoot`, most recent design.json first. The one listing the
 * command and the canvas server share: a kebab-case entry counts, symlink or
 * not, when its real path stays inside the real design root and it has a
 * design.json file that also resolves inside it. An invalid manifest is listed
 * with valid: false and its slug as the title.
 */
export function listDesignEntries(designRoot: string): DesignListing[] {
	let root: string;
	let entries;
	try {
		root = realpathSync(designRoot);
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const designs: DesignListing[] = [];
	for (const entry of entries) {
		if (!SLUG.test(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
		let path: string;
		let info;
		try {
			const design = realpathSync(join(root, entry.name));
			if (!within(root, design) || design === root) continue;
			path = realpathSync(join(design, "design.json"));
			if (!within(design, path)) continue;
			info = statSync(path);
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		if (!info.isFile()) continue;
		let title = entry.name;
		let valid = false;
		let parent: DesignListing["parent"];
		try {
			if (info.size <= LIMITS.manifestBytes) {
				const manifest = normalizeManifest(entry.name, readFileSync(path, "utf8"));
				title = manifest.title;
				parent = manifest.parent;
				valid = true;
			}
		} catch {
			valid = false;
		}
		designs.push({ slug: entry.name, title, mtime: info.mtimeMs, valid, ...(parent ? { parent } : {}) });
	}
	return designs.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
}

/** Real path of `<designRoot>/system.html` when it is a file inside the real design root, else undefined. */
export function resolveSystemBoard(designRoot: string): string | undefined {
	try {
		const root = realpathSync(designRoot);
		const target = realpathSync(join(root, SYSTEM_FILE));
		if (!within(root, target) || target === root) return undefined;
		return statSync(target).isFile() && extname(target).toLowerCase() === ".html" ? target : undefined;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** Real path of `<designRoot>/<slug>/<relative>` when it stays inside that design, else undefined. */
function resolveDesignFileSync(designRoot: string, slug: string, segments: string[]): string | undefined {
	if (!SLUG.test(slug)) return undefined;
	try {
		const root = realpathSync(designRoot);
		const design = realpathSync(join(root, slug));
		if (!within(root, design) || design === root) return undefined;
		const target = realpathSync(join(design, ...segments));
		return within(design, target) && target !== design ? target : undefined;
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** The normalized manifest of one design, with the server's containment and limits; throws a reason when it cannot be read. */
export function readDesignManifest(designRoot: string, slug: string): DesignManifest {
	const path = resolveDesignFileSync(designRoot, slug, ["design.json"]);
	if (!path || !statSync(path).isFile()) throw new Error(`No design "${slug}" in design/.`);
	if (statSync(path).size > LIMITS.manifestBytes) throw new Error(`design/${slug}/design.json is too large`);
	try {
		return normalizeManifest(slug, readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`design/${slug}/design.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Whether `<designRoot>/system.md` is a contained file, so a handoff can name it as the token source. */
export function hasSystemTokens(designRoot: string): boolean {
	try {
		const root = realpathSync(designRoot);
		const target = realpathSync(join(root, "system.md"));
		return within(root, target) && statSync(target).isFile();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

export async function startDesignCanvasServer(options: DesignCanvasServerOptions): Promise<DesignCanvasServer> {
	if (typeof options.designRoot !== "string" || !isAbsolute(options.designRoot)) throw new Error("designRoot must be an absolute path");
	if (typeof options.onComment !== "function") throw new Error("onComment must be a function");
	if (options.initialSlug !== undefined && !SLUG.test(options.initialSlug)) throw new Error("initialSlug must be kebab-case");
	const token = (options.randomToken ?? (() => randomBytes(24).toString("base64url")))();
	if (!TOKEN_SHAPE.test(token)) throw new Error("token must be 16-128 base64url characters");
	const designRoot = options.designRoot;
	await mkdir(designRoot, { recursive: true });
	const status = createDesignStatusStore(designRoot);
	const sessionID = options.sessionID ?? "canvas";
	await status.ensure(sessionID);
	const store = createDesignCommentStore(designRoot);
	const systemStore = createSystemCommentStore(designRoot);
	const handoffs = createDesignHandoffStore(designRoot);
	// Share delivery locks across session canvases for the same real design root.
	// These locks are process-local; separate OpenCode services must not share a design root.
	async function exclusive<T>(slug: string, task: () => Promise<T>, system = false): Promise<T> {
		const root = await realpath(designRoot);
		return serializeDesignWrite(join(root, system ? ".system-comment-delivery" : `.delivery-${slug}`), task);
	}
	const base = `/${token}/`;
	const template = await readFile(join(ASSET_DIR, "index.html"), "utf8");

	let port = 0;
	let origin = "";
	/** This server's own origins; a canvas may be opened through either Host name. */
	let ownOrigins = new Set<string>();
	let closing: Promise<void> | undefined;
	let watcher: FSWatcher | undefined;
	const clients = new Set<ServerResponse>();
	const pending = new Map<string, NodeJS.Timeout>();
	let heartbeat: NodeJS.Timeout | undefined;

	const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (res.headersSent) return void res.destroy();
			if (error instanceof HttpError) {
				const body = error.body ?? (error.status === 422 ? { error: "invalid-manifest", reason: error.reason } : { error: error.reason });
				return reply(res, error.status, body, error.status === 413 ? { Connection: "close" } : {});
			}
			reply(res, 500, { error: "internal" });
		});
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;

	function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
		const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
		res.writeHead(status, {
			...BASE_HEADERS,
			...SAME_ORIGIN_ONLY,
			"Content-Type": "application/json; charset=utf-8",
			...headers,
			"Content-Length": String(Buffer.byteLength(payload)),
		});
		res.end(payload);
	}

	/** 200 for content the opaque-origin artboards load, so it carries no same-origin CORP. */
	function raw(res: ServerResponse, body: string | Buffer, headers: Record<string, string>): void {
		res.writeHead(200, { ...BASE_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body)) });
		res.end(body);
	}

	async function rootReal(): Promise<string | undefined> {
		try {
			return await realpath(designRoot);
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	/** Real path of `<root>/<slug>/<segments>` when it stays inside that design, else undefined. */
	async function resolveInside(slug: string, segments: string[]): Promise<string | undefined> {
		const root = await rootReal();
		if (!root || !SLUG.test(slug)) return undefined;
		try {
			const design = await realpath(join(root, slug));
			if (!within(root, design) || design === root) return undefined;
			const target = await realpath(join(design, ...segments));
			return within(design, target) && target !== design ? target : undefined;
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
	}

	const resolveSystem = async (): Promise<string | undefined> => resolveSystemBoard(designRoot);

	async function readManifest(slug: string): Promise<DesignManifest> {
		const path = await resolveInside(slug, ["design.json"]);
		if (!path) throw new HttpError(404, "not-found");
		const info = await stat(path);
		if (!info.isFile()) throw new HttpError(404, "not-found");
		if (info.size > LIMITS.manifestBytes) throw new HttpError(422, "design.json is too large");
		return normalizeManifest(slug, await readFile(path, "utf8"));
	}

	function canvasPage(res: ServerResponse, slug: string | null): void {
		const html = template
			.replaceAll("{{BASE}}", escapeHtml(base))
			.replace("{{CONFIG}}", () => scriptJson({ base, slug }));
		reply(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CANVAS_CSP });
	}

	async function serveAsset(res: ServerResponse, name: string | null): Promise<void> {
		if (!name || !Object.hasOwn(ASSETS, name)) throw new HttpError(404, "not-found");
		raw(res, await readFile(join(ASSET_DIR, name)), { "Content-Type": ASSETS[name] });
	}

	/** Artboard responses are CSP-sandboxed so even a top-level visit gets an opaque origin. */
	function artboardCsp(host: string): string {
		const self = `'self' http://${host}`;
		return [
			"sandbox allow-scripts",
			`default-src ${self} 'unsafe-inline' data: blob:`,
			"connect-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			`frame-ancestors http://${HOST}:${port} http://localhost:${port}`,
		].join("; ");
	}

	async function serveFile(req: IncomingMessage, res: ServerResponse, slug: string, segments: string[]): Promise<void> {
		const type = FILE_TYPES[extname(segments[segments.length - 1]).toLowerCase()];
		if (!type) throw new HttpError(404, "not-found");
		const target = await resolveInside(slug, segments);
		if (!target || FILE_TYPES[extname(target).toLowerCase()] !== type) throw new HttpError(404, "not-found");
		return serveResolved(req, res, target, type);
	}

	async function serveSystem(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const target = await resolveSystem();
		if (!target || extname(target).toLowerCase() !== ".html") throw new HttpError(404, "not-found");
		return serveResolved(req, res, target, FILE_TYPES[".html"]);
	}

	/** Serves a real path already contained by the caller, as an artboard resource. */
	async function serveResolved(req: IncomingMessage, res: ServerResponse, target: string, type: string): Promise<void> {
		// Read the already-resolved real path so a swapped link cannot redirect the read.
		const handle = await open(target, "r").catch((error: unknown) => { if (isMissing(error)) throw new HttpError(404, "not-found"); throw error; });
		let content: Buffer;
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new HttpError(404, "not-found");
			if (info.size > LIMITS.fileBytes) throw new HttpError(413, "file-too-large");
			content = await handle.readFile();
		} finally {
			await handle.close();
		}
		const body = type.startsWith("text/html")
			? injectInspector(content.toString("utf8"), `<script src="${escapeHtml(base)}assets/inspector.js"></script>`)
			: content;
		raw(res, body, { "Content-Type": type, "Content-Security-Policy": artboardCsp(String(req.headers.host)) });
	}

	async function readJsonObject(req: IncomingMessage, allowEmpty = false, limit: number = LIMITS.bodyBytes): Promise<Record<string, unknown>> {
		const raw = await readBody(req, limit);
		if (allowEmpty && raw.trim() === "") return {};
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new HttpError(400, "invalid-json");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid-body");
		return value as Record<string, unknown>;
	}

	/** The stored comment as a session comment of design `slug`, with its screenshot loaded when it has one. */
	async function toDesignComment(slug: string, stored: StoredDesignComment): Promise<DesignComment> {
		const comment: DesignComment = { id: stored.id, slug, ...designCommentTarget(stored), comment: stored.comment };
		if (stored.screenshot) {
			const image = await (stored.scope === "system" ? systemStore : store).readScreenshot(slug, stored.id).catch(() => undefined);
			const ext = extname(stored.screenshot).toLowerCase();
			comment.screenshot = { path: stored.scope === "system" ? `design/${stored.screenshot}` : `design/${slug}/${stored.screenshot}`, mimeType: image?.mimeType ?? FILE_TYPES[ext] };
			if (image) comment.screenshot.data = image.data.toString("base64");
		}
		return comment;
	}

	/** The optional `screenshot: { mimeType, data: base64 }` of a comment body, decoded. */
	function parseScreenshot(value: unknown): { mimeType: string; data: Buffer } | undefined {
		if (value === undefined) return undefined;
		const invalid = (reason: string) => new HttpError(400, "invalid-screenshot", { error: "invalid-screenshot", reason });
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("screenshot must be an object with mimeType and data");
		const { mimeType, data } = value as Record<string, unknown>;
		if (typeof mimeType !== "string" || !Object.hasOwn(DESIGN_SCREENSHOT_TYPES, mimeType)) throw invalid("screenshot must be a PNG, JPEG, WebP or GIF image");
		if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalid("screenshot data must be base64");
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > MAX_DESIGN_SCREENSHOT_BYTES) throw invalid(`screenshot must be at most ${MAX_DESIGN_SCREENSHOT_BYTES} bytes`);
		return { mimeType, data: bytes };
	}

	async function receiveComment(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJsonObject(req, false, LIMITS.commentBodyBytes);
		// Only the screenshot gets the larger allowance; the rest of the body keeps the usual limit.
		const shotChars = typeof (body.screenshot as { data?: unknown } | undefined)?.data === "string" ? ((body.screenshot as { data: string }).data.length) : 0;
		if (Buffer.byteLength(JSON.stringify(body)) - shotChars > LIMITS.bodyBytes) throw new HttpError(413, "body-too-large");
		const mode = body.mode ?? "send";
		if (mode !== "send" && mode !== "collect") throw new HttpError(400, "invalid-mode");
		const scope = body.scope === undefined ? "element" : body.scope;
		if (scope !== "element" && scope !== "general" && scope !== "system") throw new HttpError(400, "invalid-scope");
		const system = scope === "system";
		if (system ? body.slug !== undefined : typeof body.slug !== "string" || !SLUG.test(body.slug)) throw new HttpError(400, "invalid-slug");
		if (typeof body.comment !== "string") throw new HttpError(400, "invalid-comment");
		const comment = body.comment.replace(/\r\n?/g, "\n").trim();
		if (comment.length < 1 || comment.length > LIMITS.comment) throw new HttpError(400, "invalid-comment");
		let target: DesignCommentTarget;
		if (scope === "system") {
			if (body.file !== undefined || !(await resolveSystem())) throw new HttpError(400, "invalid-system-target");
			if (body.selector !== undefined && (typeof body.selector !== "string" || !body.selector.trim() || body.selector.length > LIMITS.selector)) throw new HttpError(400, "invalid-selector");
			if (body.excerpt !== undefined && (body.selector === undefined || typeof body.excerpt !== "string")) throw new HttpError(400, "invalid-excerpt");
			target = { scope: "system", ...(typeof body.selector === "string" ? { selector: collapse(body.selector), excerpt: truncateUtf16(collapse(typeof body.excerpt === "string" ? body.excerpt : ""), LIMITS.excerpt) } : {}) };
		} else if (scope === "general") {
			if (body.file !== undefined || body.selector !== undefined || body.excerpt !== undefined) throw new HttpError(400, "invalid-general-target");
			if ((await readManifest(body.slug as string)).artboards.length === 0) throw new HttpError(400, "no-proposals");
			target = { scope: "general" };
		} else {
			const segments = relativeSegments(body.file);
			if (!segments || extname(segments[segments.length - 1]).toLowerCase() !== ".html") throw new HttpError(400, "invalid-file");
			if (typeof body.selector !== "string") throw new HttpError(400, "invalid-selector");
			const selector = collapse(body.selector);
			if (selector.length < 1 || selector.length > LIMITS.selector) throw new HttpError(400, "invalid-selector");
			if (body.excerpt !== undefined && typeof body.excerpt !== "string") throw new HttpError(400, "invalid-excerpt");
			const excerpt = truncateUtf16(collapse(typeof body.excerpt === "string" ? body.excerpt : ""), LIMITS.excerpt).trim();
			const path = await resolveInside(body.slug as string, segments);
			const info = path ? await stat(path).catch(() => undefined) : undefined;
			if (!path || !info?.isFile() || extname(path).toLowerCase() !== ".html") throw new HttpError(400, "invalid-file");
			target = { ...(body.scope === "element" ? { scope: "element" as const } : {}), file: segments.join("/"), selector, excerpt };
		}
		const slug = system ? "" : body.slug as string;
		const commentStore = system ? systemStore : store;
		const screenshot = parseScreenshot(body.screenshot);
		const input: DesignCommentInput = { ...target, comment, ...(screenshot ? { screenshot } : {}) };
		const add = () => commentStore.add(slug, input).catch((error: unknown) => {
			if (screenshot && error instanceof DesignCommentsError && error.code === "invalid-input") throw new HttpError(400, "invalid-screenshot", { error: "invalid-screenshot", reason: error.message });
			return storeFailure(error);
		});
		if (mode === "collect") {
			const stored = await add();
			return reply(res, 201, { ok: true, id: stored.id, sent: false });
		}
		// Save, deliver and mark sent under the design's delivery lock, so a send-all cannot see it unsent mid-flight.
		return exclusive(slug, async () => {
			const stored = await add();
			const delivered = await toDesignComment(slug, stored);
			try {
				await options.onComment(delivered);
			} catch {
				throw new HttpError(500, "delivery-failed", { error: "delivery-failed", id: stored.id, saved: true, sent: false });
			}
			await commentStore.markSent(slug, [stored.id]).catch(storeFailure);
			reply(res, 202, { ok: true, id: stored.id, sent: true });
		}, system);
	}

	async function sendAll(req: IncomingMessage, res: ServerResponse, slug: string, system = false): Promise<void> {
		await readJsonObject(req, true);
		const commentStore = system ? systemStore : store;
		return exclusive(slug, async () => {
			const unsent = (await commentStore.listOpen(slug).catch(storeFailure)).filter((comment) => comment.sentAt === null);
			if (unsent.length === 0) return reply(res, 200, { ok: true, sent: 0, ids: [] });
			if (!options.onComments) throw new HttpError(501, "batch-delivery-unavailable");
			const ids = unsent.map((comment) => comment.id);
			const batch = await Promise.all(unsent.map((comment) => toDesignComment(slug, comment)));
			try {
				await options.onComments(batch);
			} catch {
				throw new HttpError(500, "delivery-failed", { error: "delivery-failed", ids, saved: true, sent: false });
			}
			await commentStore.markSent(slug, ids).catch(storeFailure);
			reply(res, 202, { ok: true, sent: ids.length, ids });
		}, system);
	}

	async function requestPage(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
		const body = await readJsonObject(req);
		if (!options.onPage) throw new HttpError(501, "page-generation-unavailable");
		if (typeof body.id !== "string" || !PAGE_REQUEST_ID.test(body.id) || typeof body.brief !== "string" || !body.brief.trim() || body.brief.length > 4000 || !Number.isInteger(body.count ?? 3) || Number(body.count ?? 3) < 3 || Number(body.count ?? 3) > 12) throw new HttpError(400, "invalid-page-request");
		const manifest = await readManifest(slug);
		if (typeof body.file !== "string" || !manifest.artboards.some((board) => board.file === body.file) || !(await resolveInside(slug, relativeSegments(body.file) ?? []))) throw new HttpError(400, "invalid-reference");
		try {
			const page = await sendDesignPage(designRoot, { id: body.id, parent: { slug, file: body.file }, brief: body.brief.trim(), count: Number(body.count ?? 3) }, options.onPage);
			reply(res, 202, { ok: true, id: page.id, slug: page.slug });
		} catch (error) {
			if (error instanceof PageRequestConflict) throw new HttpError(409, "page-request-changed");
			throw new HttpError(500, "page-request-failed", { error: "page-request-failed", id: body.id, reason: error instanceof Error ? error.message : "Unable to queue page" });
		}
	}

	/** Resolve a bounded family; malformed, missing and cyclic links never hide the selected design. */
	async function family(slug: string): Promise<{ designs: DesignManifest[]; warnings: string[] }> {
		const selected = await readManifest(slug);
		const found = new Map<string, DesignManifest>([[slug, selected]]);
		const warnings: string[] = [];
		for (const entry of listDesignEntries(designRoot).slice(0, 100)) {
			if (!entry.valid || found.has(entry.slug)) continue;
			try { found.set(entry.slug, await readManifest(entry.slug)); } catch { /* unrelated damaged manifests stay isolated */ }
		}
		let ancestor = selected;
		const seen = new Set([slug]);
		while (ancestor.parent) {
			const parent = found.get(ancestor.parent.slug);
			if (!parent || seen.has(parent.slug) || !parent.artboards.some((b) => b.file === ancestor.parent!.file)) { warnings.push("Missing or cyclic reference: showing available proposals only."); break; }
			seen.add(parent.slug);
			ancestor = parent;
		}
		const result: DesignManifest[] = [];
		let count = 0;
		const visit = (node: DesignManifest, depth: number) => {
			if (result.some((d) => d.slug === node.slug)) return;
			if (depth > 8 || count + node.artboards.length > 60) { warnings.push("Family preview limit reached; open a smaller page family to see more."); return; }
			result.push(node); count += node.artboards.length;
			for (const child of found.values()) if (child.parent?.slug === node.slug && !seen.has(child.slug) && node.artboards.some((b) => b.file === child.parent!.file)) visit(child, depth + 1);
		};
		visit(selected, 0);
		const parent = selected.parent && found.get(selected.parent.slug);
		const reference = parent?.artboards.find(board => board.file === selected.parent!.file);
		if (parent && reference && parent.slug !== slug && !result.some(design => design.slug === parent.slug)) {
			result.unshift({ ...parent, artboards: [reference] });
		}
		return { designs: result, warnings };
	}

	async function implement(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
		const body = await readJsonObject(req);
		if (!options.onImplement) throw new HttpError(501, "implement-unavailable");
		const segments = relativeSegments(body.file);
		if (!segments) throw new HttpError(400, "invalid-file");
		const file = segments.join("/");
		const manifest = await readManifest(slug);
		if (!manifest.artboards.some((artboard) => artboard.file === file)) throw new HttpError(400, "invalid-file", { error: "invalid-file", reason: `${file} is not an artboard of design/${slug}` });
		const onImplement = options.onImplement;
		let deliveryFailed: HttpError | undefined;
		// Recorded before delivery, so the agent can report progress on it at once (S15);
		// a failed delivery takes the record back. The refusal reason reaches the canvas.
		const { queued } = await sendDesignHandoff(handoffs, { slug, file }, async () => {
			try {
				return await onImplement({ slug, file });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				deliveryFailed = new HttpError(500, "delivery-failed", { error: "delivery-failed", slug, file, reason });
				throw deliveryFailed;
			}
		}).catch((error: unknown) => (deliveryFailed !== undefined && error === deliveryFailed ? Promise.reject(error) : handoffFailure(error)));
		reply(res, 202, { ok: true, slug, file, queued });
	}

	async function serveScreenshot(res: ServerResponse, slug: string, id: string, system = false): Promise<void> {
		const image = await (system ? systemStore : store).readScreenshot(slug, id).catch(storeFailure);
		if (!image) throw new HttpError(404, "not-found");
		reply(res, 200, image.data, { "Content-Type": image.mimeType });
	}

	async function changeStatus(req: IncomingMessage, res: ServerResponse, slug: string, id: string, system = false): Promise<void> {
		const body = await readJsonObject(req);
		if (body.status !== "open" && body.status !== "resolved") throw new HttpError(400, "invalid-status");
		const { updated } = await (system ? systemStore : store).setStatus(slug, [id], body.status).catch(storeFailure);
		if (updated.length === 0) throw new HttpError(404, "not-found");
		reply(res, 200, { ok: true, comment: updated[0] });
	}

	function broadcast(chunk: string): void {
		for (const client of clients) client.write(chunk);
	}

	function queueChange(filename: string): void {
		if (closing) return;
		const parts = filename.split(/[\\/]/);
		if (parts.length === 1 && parts[0] === DESIGN_STATUS_FILE) return debounceChange(DESIGN_STATUS_FILE, null, DESIGN_STATUS_FILE);
		if (parts.length === 1 && SYSTEM_FILES.has(parts[0])) return debounceChange(parts[0], null, parts[0]);
		const [slug, ...rest] = parts;
		if (!SLUG.test(slug) || rest.length === 0 || rest.some((part) => part === "" || part.startsWith("."))) return;
		if (!FILE_TYPES[extname(rest[rest.length - 1]).toLowerCase()]) return;
		const file = rest.join("/");
		debounceChange(`${slug}/${file}`, slug, file);
	}

	function debounceChange(key: string, slug: string | null, file: string): void {
		clearTimeout(pending.get(key));
		pending.set(key, setTimeout(() => {
			pending.delete(key);
			broadcast(`event: change\ndata: ${JSON.stringify({ slug, file })}\n\n`);
		}, DEBOUNCE_MS));
	}

	/** Recursive watch on the real design root; a failed or missing watch is retried by the next stream. */
	async function ensureWatcher(): Promise<void> {
		if (watcher || closing) return;
		const root = await rootReal();
		if (!root || watcher || closing) return;
		try {
			const next = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
				if (typeof filename === "string" && filename) queueChange(filename);
			});
			next.on("error", () => {
				next.close();
				if (watcher === next) watcher = undefined;
			});
			watcher = next;
		} catch {
			watcher = undefined;
		}
	}

	async function openEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (clients.size >= LIMITS.sseClients) throw new HttpError(503, "too-many-streams");
		await ensureWatcher();
		res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
		res.write("retry: 2000\n\n: connected\n\n");
		clients.add(res);
		req.socket.setTimeout(0);
		const drop = () => clients.delete(res);
		req.on("close", drop);
		res.on("error", drop);
		heartbeat ??= setInterval(() => broadcast(": ping\n\n"), HEARTBEAT_MS);
		heartbeat.unref();
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const host = req.headers.host;
		if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return reply(res, 421, { error: "misdirected" });
		const raw = String(req.url ?? "");
		if (!raw.startsWith("/")) return reply(res, 404, { error: "not-found" });
		const mark = raw.indexOf("?");
		const parts = (mark === -1 ? raw : raw.slice(0, mark)).split("/");
		// parts[0] is the empty string before the leading slash.
		if (parts.length < 3 || !sameToken(token, parts[1])) return reply(res, 404, { error: "not-found" });
		const rest = parts.slice(2);
		const method = req.method ?? "GET";
		const post = postRoute(rest);
		const get = post ? undefined : route(rest);
		// Unknown paths stay 404 whatever the method; only known routes answer 405.
		if (!post && !get) return reply(res, 404, { error: "not-found" });
		if (method !== (post ? "POST" : "GET")) return reply(res, 405, { error: "method-not-allowed" }, { Allow: post ? "POST" : "GET" });
		if (post) {
			// Every write needs this server's exact Origin and a JSON body, so no other page can forge one.
			if (!ownOrigins.has(String(req.headers.origin))) return reply(res, 403, { error: "forbidden" });
			if (mediaType(req) !== "application/json") return reply(res, 415, { error: "unsupported-media-type" });
			return post(req, res);
		}
		// Browsers send Origin on cross-origin reads; only this server's pages may read it.
		// Sandboxed artboards fetch their own subresources with `Origin: null`.
		const requestOrigin = req.headers.origin;
		const artboardSubresource = rest[0] === "files" || (rest.length === 1 && rest[0] === SYSTEM_FILE) || (rest.length === 2 && rest[0] === "assets" && rest[1] === "inspector.js");
		const trusted = requestOrigin === undefined || ownOrigins.has(requestOrigin) || (requestOrigin === "null" && artboardSubresource);
		if (!trusted) return reply(res, 403, { error: "forbidden" });
		return get!(req, res);
	}

	type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

	/** POST route table over raw segments after the token. */
	function postRoute(rest: string[]): Handler | undefined {
		if (rest.length === 4 && rest[0] === "api" && rest[1] === "designs" && rest[3] === "discard") {
			const slug = safeSegment(rest[2]);
			if (!slug || !SLUG.test(slug)) return undefined;
			return async (req, res) => {
				const body = await readJsonObject(req);
				if (typeof body.file !== "string") throw new HttpError(400, "invalid-file");
				const target = await locateDesignFile(designRoot, slug, "design.json", () => new HttpError(404, "not-found"));
				await serializeDesignWrite(target.path, async () => {
					const raw = await readDesignFile(target.path, LIMITS.manifestBytes, () => new HttpError(422, "manifest-too-large"));
					if (raw === undefined) throw new HttpError(404, "not-found");
					normalizeManifest(slug, raw);
					const document = JSON.parse(raw);
					if (!document.artboards.some((board: { file: string }) => board.file === body.file) || !relativeSegments(body.file)) throw new HttpError(400, "invalid-file");
					for (const entry of listDesignEntries(designRoot)) {
						if (!entry.valid) continue;
						const parent = (await readManifest(entry.slug)).parent;
						if (parent?.slug === slug && parent.file === body.file) throw new HttpError(409, "proposal-has-connected-pages", { error: "proposal-has-connected-pages", reason: "This proposal is a reference for connected pages and cannot be discarded." });
					}
					const commentsPath = join(target.dir, "comments.json"), handoffsPath = join(target.dir, "handoffs.json");
					await serializeDesignWrite(commentsPath, () => serializeDesignWrite(handoffsPath, async () => {
						const comments = await store.read(slug);
						const history = await handoffs.read(slug);
						const removed = comments.comments.filter((comment) => comment.file === body.file);
						const retainedShots = new Set(comments.comments.filter((comment) => comment.file !== body.file).map((comment) => comment.screenshot));
						const files = [join(target.dir, body.file as string), ...removed.flatMap((comment) => comment.screenshot && !retainedShots.has(comment.screenshot) ? [join(target.dir, comment.screenshot)] : [])];
						const present: string[] = [];
						for (const file of files) {
							try {
								if (!(await lstat(file)).isFile() || await realpath(dirname(file)) !== dirname(file)) throw new HttpError(409, "linked-proposal-files-cannot-be-deleted");
								present.push(file);
							} catch (error) { if (!isMissing(error)) throw error; }
						}
						const backups = new Map<string, string>();
						backups.set(target.path, raw);
						for (const name of ["comments.json", "handoffs.json"]) {
							const located = await locateDesignFile(designRoot, slug, name, () => new HttpError(422, "invalid-history"));
							const value = await readDesignFile(located.path, 4 * 1024 * 1024, () => new HttpError(422, "history-too-large"));
							if (value !== undefined) backups.set(located.path, value);
						}
						document.artboards = document.artboards.filter((board: { file: string }) => board.file !== body.file);
						comments.comments = comments.comments.filter((comment) => comment.file !== body.file);
						delete history.handoffs[body.file as string];
						if (history.chosen === body.file) history.chosen = null;
						const updates = new Map([[target.path, document], [commentsPath, comments], [handoffsPath, history]]);
						const staged: Array<[string, string]> = [];
						try {
							for (const file of new Set(present)) {
								const temp = join(dirname(file), `.discard-${randomBytes(16).toString("hex")}`);
								await rename(file, temp); staged.push([file, temp]);
							}
							for (const [path, value] of updates) if (backups.has(path)) await replaceDesignFile(target.dir, path, path.slice(target.dir.length + 1), JSON.stringify(value, null, 2) + "\n");
						} catch (error) {
							for (const [path, value] of backups) await replaceDesignFile(target.dir, path, path.slice(target.dir.length + 1), value);
							for (const [file, temp] of staged) await rename(temp, file);
							throw error;
						}
						for (const [, temp] of staged) await unlink(temp);
					}));
				});
				reply(res, 200, { ok: true });
			};
		}
		if (rest.length === 2 && rest[0] === "api" && rest[1] === "implement") return async (req, res) => {
			const body = await readJsonObject(req);
			if (!options.onImplementMany) throw new HttpError(501, "batch-implementation-unavailable");
			if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 20) throw new HttpError(400, "select-1-to-20-pages");
			const targets: DesignImplementRequest[] = [];
			for (const value of body.targets) {
				if (!value || typeof value !== "object" || typeof value.slug !== "string" || !SLUG.test(value.slug) || typeof value.file !== "string" || targets.some((target) => target.slug === value.slug)) throw new HttpError(400, "select-one-proposal-per-page");
				const manifest = await readManifest(value.slug);
				if (!manifest.artboards.some((board) => board.file === value.file)) throw new HttpError(400, "invalid-file");
				targets.push({ slug: value.slug, file: value.file });
			}
			try {
				const delivery = await options.onImplementMany(targets);
				reply(res, 202, { ok: true, queued: delivery?.queued === true, targets });
			} catch (error) { throw new HttpError(500, "implementation-failed", { error: "implementation-failed", reason: error instanceof Error ? error.message : "Unable to send selection" }); }
		};
		if (rest.length === 4 && rest[0] === "api" && rest[1] === "designs" && rest[3] === "pages") {
			const slug = safeSegment(rest[2]);
			return slug && SLUG.test(slug) ? (req, res) => requestPage(req, res, slug) : undefined;
		}
		if (rest.length === 2 && rest[0] === "api" && rest[1] === "comments") return receiveComment;
		if (rest[0] === "api" && rest[1] === "system" && rest[2] === "comments") {
			if (rest.length === 4 && rest[3] === "send-all") return (req, res) => sendAll(req, res, "", true);
			const id = rest[3] && safeSegment(rest[3]);
			if (rest.length === 5 && rest[4] === "status" && id && isDesignCommentId(id)) return (req, res) => changeStatus(req, res, "", id, true);
		}
		if (rest.length === 4 && rest[0] === "api" && rest[1] === "designs" && rest[3] === "implement") {
			const slug = safeSegment(rest[2]);
			return slug && SLUG.test(slug) ? (req, res) => implement(req, res, slug) : undefined;
		}
		if (rest.length < 5 || rest[0] !== "api" || rest[1] !== "designs" || rest[3] !== "comments") return undefined;
		const slug = safeSegment(rest[2]);
		if (!slug || !SLUG.test(slug)) return undefined;
		if (rest.length === 5 && rest[4] === "send-all") return (req, res) => sendAll(req, res, slug);
		if (rest.length === 6 && rest[5] === "status") {
			const id = safeSegment(rest[4]);
			return id && isDesignCommentId(id) ? (req, res) => changeStatus(req, res, slug, id) : undefined;
		}
		return undefined;
	}

	/** GET route table over raw (still encoded) segments after the token. */
	function route(rest: string[]): Handler | undefined {
		if (rest.length === 2 && rest[0] === "api" && rest[1] === "session-status") {
			return async (_req, res) => {
				const doc = await status.read();
				reply(res, 200, { revision: doc.revision, sessionID, requests: doc.requests.filter(r => r.sessionID === sessionID) });
			};
		}
		if (rest[0] === "api" && rest[1] === "system" && rest[2] === "comments") {
			if (rest.length === 3) return async (_req, res) => reply(res, 200, await systemStore.read("").catch(storeFailure));
			const id = rest[3] && safeSegment(rest[3]);
			if (rest.length === 5 && rest[4] === "screenshot" && id && isDesignCommentId(id)) return (_req, res) => serveScreenshot(res, "", id, true);
		}
		const [head, ...tail] = rest;
		if (rest.length === 1 && head === "") return (_req, res) => canvasPage(res, null);
		if (head === "d" && tail.length === 2 && tail[1] === "") {
			const slug = safeSegment(tail[0]);
			return slug && SLUG.test(slug) ? (_req, res) => canvasPage(res, slug) : undefined;
		}
		if (head === "assets" && tail.length === 1) return (_req, res) => serveAsset(res, safeSegment(tail[0]));
		if (head === "events" && tail.length === 0) return openEvents;
		if (head === SYSTEM_FILE && tail.length === 0) return serveSystem;
		if (head === "api" && tail.length === 1 && tail[0] === "system") {
			return async (_req, res) => reply(res, 200, { exists: (await resolveSystem()) !== undefined, file: SYSTEM_FILE, ...SYSTEM_BOARD });
		}
		if (head === "api" && tail[0] === "designs") {
			if (tail.length === 3 && tail[2] === "family") {
				const slug = safeSegment(tail[1]);
				return slug && SLUG.test(slug) ? async (_req, res) => reply(res, 200, await family(slug)) : undefined;
			}
			if (tail.length === 1) return async (_req, res) => reply(res, 200, { designs: listDesignEntries(designRoot) });
			if (tail.length === 2) {
				const slug = safeSegment(tail[1]);
				return slug && SLUG.test(slug) ? async (_req, res) => reply(res, 200, await readManifest(slug)) : undefined;
			}
			if (tail.length === 3 && tail[2] === "comments") {
				const slug = safeSegment(tail[1]);
				return slug && SLUG.test(slug) ? async (_req, res) => reply(res, 200, await store.read(slug).catch(storeFailure)) : undefined;
			}
			if (tail.length === 5 && tail[2] === "comments" && tail[4] === "screenshot") {
				const slug = safeSegment(tail[1]);
				const id = safeSegment(tail[3]);
				return slug && SLUG.test(slug) && id && isDesignCommentId(id) ? (_req, res) => serveScreenshot(res, slug, id) : undefined;
			}
			if (tail.length === 3 && tail[2] === "handoffs") {
				const slug = safeSegment(tail[1]);
				return slug && SLUG.test(slug) ? async (_req, res) => reply(res, 200, await handoffs.read(slug).catch(handoffFailure)) : undefined;
			}
		}
		if (head === "files" && tail.length >= 2) {
			const slug = safeSegment(tail[0]);
			if (!slug || !SLUG.test(slug)) return undefined;
			const segments = tail.slice(1).map(safeSegment);
			if (segments.some((segment) => segment === null)) return undefined;
			return (req, res) => serveFile(req, res, slug, segments as string[]);
		}
		return undefined;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== HOST) {
		server.close();
		throw new Error("design canvas server is not bound to 127.0.0.1");
	}
	port = address.port;
	origin = `http://${HOST}:${port}`;
	ownOrigins = new Set([origin, `http://localhost:${port}`]);
	await ensureWatcher();

	function close(): Promise<void> {
		closing ??= new Promise<void>((resolve) => {
			clearInterval(heartbeat);
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
			watcher?.close();
			watcher = undefined;
			for (const client of clients) client.destroy();
			clients.clear();
			server.close(() => resolve());
			server.closeAllConnections();
		});
		return closing;
	}

	function show(slug: string | null): number {
		if (slug !== null && (typeof slug !== "string" || !SLUG.test(slug))) throw new Error("slug must be kebab-case or null");
		if (closing) return 0;
		broadcast(`event: show\ndata: ${JSON.stringify({ slug })}\n\n`);
		return clients.size;
	}

	const url = `${origin}${base}${options.initialSlug ? `d/${options.initialSlug}/` : ""}`;
	return { url, port, token, close, connectedClients: () => clients.size, show };
}
