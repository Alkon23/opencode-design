import type { Plugin } from "@opencode/plugin/tui";

/** Observe live notices only; never replay inbox history or switch sessions. */
export function setupStopToast(ctx: Plugin.Context) {
  const [state, update] = ctx.storage.memory<{ seen: string[] }>("design-stop-toasts", { initial: { seen: [] } });
  return ctx.data.on("session.inbox.enqueued", event => {
    const item = event.data.item;
    if (item.type !== "synthetic") return;
    const notice = item.payload.metadata;
    if (notice?.source !== "opencode-design" || notice.action !== "stop" || notice.stopped !== true) return;
    const route = ctx.ui.router.current();
    if (route.type !== "session" || route.sessionID !== event.data.sessionID) return;
    if (state.seen.includes(event.data.inboxID)) return;
    update(draft => { draft.seen = [...draft.seen.slice(-127), event.data.inboxID]; });
    ctx.ui.toast.show({
      title: "OpenCode Design",
      message: "Design canvas stopped.",
      variant: "success",
      duration: 3000,
    });
  });
}
