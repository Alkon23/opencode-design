// File-backed request notifications. The host owns status; the browser owns only
// presentation and the one-second completion dismissal, never agent state.
"use strict";
window.createDesignRequestToasts = function ({ container, read, refresh, reportError }) {
	const cards = new Map();
	const seen = new Map();
	let revision = -1;
	let initialized = false;
	let loading = Promise.resolve();
	const labels = { working: "Working", queued: "Request queued", completed: "Request completed", failed: "Request failed", cancelled: "Request cancelled" };
	function animate(element, keyframes, duration) {
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
		return element.animate?.(keyframes, { duration, easing: "ease-out" }) ?? null;
	}

	function render(request, status = request.status) {
		let card = cards.get(request.id);
		if (!card) {
			const element = document.createElement("div");
			element.className = "gd-request-toast";
			const icon = document.createElement("span");
			icon.setAttribute("aria-hidden", "true");
			const content = document.createElement("div");
			content.className = "gd-request-content";
			const title = document.createElement("strong");
			const body = document.createElement("small");
			const track = document.createElement("div");
			track.className = "gd-request-track";
			track.setAttribute("aria-hidden", "true");
			track.append(document.createElement("i"));
			content.append(title, body, track);
			element.append(icon, content);
			container.append(element);
			card = { element, icon, title, body, track, timer: null, exit: null };
			cards.set(request.id, card);
			animate(element, [{ transform: "translateX(32px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], 220);
		}
		clearTimeout(card.timer);
		card.exit?.cancel();
		card.exit = null;
		card.element.className = `gd-request-toast gd-request-${status}`;
		card.icon.className = `gd-request-icon${status === "working" ? " gd-request-spinner" : ""}`;
		card.icon.textContent = status === "completed" ? "✓" : status === "queued" ? "◷" : status === "working" ? "" : "!";
		card.title.textContent = labels[status];
		card.body.textContent = status === "queued" ? "Waiting for the agent" : status === "completed" ? "Updated designs are ready." : request.body;
		card.track.hidden = status !== "working";
		return card;
	}

	async function apply(snapshot) {
		if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= revision || !Array.isArray(snapshot.requests)) return;
		revision = snapshot.revision;
		const first = !initialized;
		initialized = true;
		// Render queued/working items first, even if a completion needs a slow refresh.
		for (const request of snapshot.requests) {
			if (request && typeof request.id === "string" && typeof request.body === "string" && ["working", "queued"].includes(request.status)) render(request);
		}
		for (const request of snapshot.requests) {
			if (!request || typeof request.id !== "string" || !labels[request.status] || typeof request.body !== "string") continue;
			const previous = seen.get(request.id);
			seen.set(request.id, request.status);
			if (request.status === "working" || request.status === "queued") {
				continue;
			}
			// Do not replay historical notifications on page load or every SSE reconnect.
			if (first || previous === request.status) continue;
			if (request.status === "completed") {
				render({ ...request, body: "Loading updated designs…" }, "working");
				try { await refresh(); }
				catch (error) {
					// A later snapshot may retry the refresh; never claim completion early.
					seen.set(request.id, "working");
					revision = -1;
					reportError(error);
					continue;
				}
			}
			const card = render(request);
			card.timer = setTimeout(() => {
				const exit = animate(card.element, [{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-20px)", opacity: 0 }], 180);
				card.exit = exit;
				const remove = () => {
					if (card.exit !== exit) return; // A retry revived this same card.
					card.element.remove();
					cards.delete(request.id);
				};
				if (exit) exit.finished.then(remove, () => {});
				else remove();
			}, request.status === "completed" ? 1000 : 5000);
		}
	}

	return {
		// Serialize reconnects and file notifications so stale fetches cannot regress cards.
		load() {
			loading = loading.catch(() => {}).then(async () => apply(await read())).catch(reportError);
			return loading;
		},
	};
};
