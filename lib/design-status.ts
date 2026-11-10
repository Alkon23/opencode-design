import { locateRootFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

export const DESIGN_STATUS_FILE = "session-status.json";
export type RequestStatus = "queued" | "working" | "completed" | "failed" | "cancelled";
export type DesignRequest = {
	id: string;
	sessionID: string;
	status: RequestStatus;
	body: string;
	commentIDs: string[];
	updatedAt: string;
};
type StatusDocument = { version: 1; revision: number; sessions: string[]; requests: DesignRequest[] };
const statuses = new Set<RequestStatus>(["queued", "working", "completed", "failed", "cancelled"]);
const terminal = (request: DesignRequest) => !["queued", "working"].includes(request.status);

/** A project artifact, shared by session canvases, with atomic, serialized writes. */
export function createDesignStatusStore(designRoot: string) {
	async function location() { return locateRootFile(designRoot, DESIGN_STATUS_FILE); }
	async function read(): Promise<StatusDocument> {
		const { path } = await location();
		const invalid = () => new Error(`Invalid .design/${DESIGN_STATUS_FILE}; refusing to overwrite it.`);
		const raw = await readDesignFile(path, 4 * 1024 * 1024, invalid);
		if (raw === undefined) return { version: 1, revision: 0, sessions: [], requests: [] };
		let doc: StatusDocument;
		try { doc = JSON.parse(raw); } catch { throw invalid(); }
		if (!doc || doc.version !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
			!Array.isArray(doc.sessions) || !doc.sessions.every(id => typeof id === "string") ||
			!Array.isArray(doc.requests) || !doc.requests.every(r => r && typeof r.id === "string" &&
				typeof r.sessionID === "string" && doc.sessions.includes(r.sessionID) && statuses.has(r.status) &&
				typeof r.body === "string" && r.body.length <= 300 && typeof r.updatedAt === "string" &&
				Number.isFinite(Date.parse(r.updatedAt)) && Array.isArray(r.commentIDs) && r.commentIDs.every(id => typeof id === "string")) ||
			new Set(doc.requests.map(r => JSON.stringify([r.sessionID, r.id]))).size !== doc.requests.length) throw invalid();
		return doc;
	}
	async function update(change: (doc: StatusDocument) => void) {
		const { dir, path } = await location();
		return serializeDesignWrite(path, async () => {
			const doc = await read();
			const before = JSON.stringify(doc);
			change(doc);
			if (JSON.stringify(doc) !== before) {
				// Bound history without ever discarding active requests.
				const history = doc.requests.filter(terminal).slice(-100);
				doc.requests = [...doc.requests.filter(r => !terminal(r)), ...history];
				doc.revision++;
				await replaceDesignFile(dir, path, DESIGN_STATUS_FILE, JSON.stringify(doc, null, 2) + "\n");
			}
			return doc;
		});
	}
	function set(request: DesignRequest, status: RequestStatus, body?: string) {
		if (request.status === status && (body === undefined || body === request.body)) return;
		request.status = status;
		if (body !== undefined) request.body = body.slice(0, 300);
		request.updatedAt = new Date().toISOString();
	}
	return {
		read,
		reconcile: (sessionID: string, revision: number, changes: Array<{ id: string; status: RequestStatus; body: string }>) => update(doc => {
			// Native reads can race live events; never replace a newer event projection.
			if (doc.revision !== revision) return;
			for (const change of changes) {
				const request = doc.requests.find(r => r.sessionID === sessionID && r.id === change.id);
				if (request && !terminal(request)) set(request, change.status, change.body);
			}
		}),
		ensure: (sessionID: string) => update(doc => { if (!doc.sessions.includes(sessionID)) doc.sessions.push(sessionID); }),
		queue: (sessionID: string, id: string, body: string, commentIDs: string[] = []) => update(doc => {
			if (!doc.sessions.includes(sessionID)) doc.sessions.push(sessionID);
			const existing = doc.requests.find(r => r.sessionID === sessionID && r.id === id);
			if (existing) {
				if (existing.status === "failed") set(existing, "queued", body);
				return;
			}
			doc.requests.push({ sessionID, id, status: "queued", body: body.slice(0, 300), commentIDs, updatedAt: new Date().toISOString() });
		}),
		pickup: (sessionID: string, id: string) => update(doc => {
			const next = doc.requests.find(r => r.sessionID === sessionID && r.id === id);
			if (!next || next.status === "working" || next.status === "completed" || next.status === "cancelled") return;
			// These prompts use queue delivery: another pickup is an idle boundary,
			// even when the host keeps the same execution alive to drain the queue.
			for (const r of doc.requests) if (r.sessionID === sessionID && r.status === "working") set(r, "completed", "Updated designs are ready.");
			set(next, "working");
		}),
		finish: (sessionID: string, status: "completed" | "failed" | "cancelled", body: string, includeQueued = false) => update(doc => {
			for (const r of doc.requests) if (r.sessionID === sessionID && (r.status === "working" || includeQueued && r.status === "queued")) set(r, status, body);
		}),
		admissionFailed: (sessionID: string, id: string) => update(doc => {
			const request = doc.requests.find(r => r.sessionID === sessionID && r.id === id);
			if (request?.status === "queued") set(request, "failed", "Delivery could not be confirmed. Retry your request.");
		}),
		cancel: (sessionID: string, id: string) => update(doc => {
			const request = doc.requests.find(r => r.sessionID === sessionID && r.id === id);
			if (request && !terminal(request)) set(request, "cancelled", "Request cancelled.");
		}),
		progress: (sessionID: string, body: string) => update(doc => {
			for (const r of doc.requests) if (r.sessionID === sessionID && r.status === "working") set(r, "working", body);
		}),
	};
}
