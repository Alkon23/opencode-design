import assert from "node:assert/strict";
import test from "node:test";
import type { Plugin } from "@opencode/plugin/tui";
import { setupStopToast } from "../src/stop-toast.ts";

test("stop toast follows the active session, result, deduplication and cleanup", () => {
  let listener: (event: any) => void = () => {};
  let route: any = { type: "session", sessionID: "a" };
  const state = { seen: [] as string[] };
  const shown: any[] = [];
  let removed = false;
  let keymapLayers = 0;
  const ctx = {
    keymap: { layer: () => { keymapLayers++; } },
    storage: { memory: () => [state, (update: (draft: typeof state) => void) => update(state)] },
    data: { on: (type: string, callback: typeof listener) => {
      assert.equal(type, "session.inbox.enqueued"); listener = callback; return () => { removed = true; };
    } },
    ui: { router: { current: () => route }, toast: { show: (toast: unknown) => shown.push(toast) } },
  } as unknown as Plugin.Context;

  const cleanup = setupStopToast(ctx);
  assert.equal(shown.length, 0, "loading the TUI part stays silent until something happens");
  assert.equal(keymapLayers, 0, "no diagnostic command is registered");

  const metadata = { source: "opencode-design", action: "stop", directory: "project", stopped: true };
  const event = { id: "one", data: { sessionID: "a", inboxID: "inbox-one", item: { type: "synthetic", payload: { metadata } } } };
  const withMetadata = (value: object) => ({ ...event, data: { ...event.data, item: { type: "synthetic", payload: { metadata: value } } } });

  listener({ ...event, data: { ...event.data, sessionID: "b" } });
  listener(withMetadata({}));
  listener({ ...event, data: { ...event.data, item: { type: "user", payload: { metadata } } } });
  route = { type: "home" }; listener(event);
  assert.equal(shown.length, 0, "unrelated sessions, items, and routes stay silent");

  route = { type: "session", sessionID: "a" };
  listener(event); listener(event);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], { title: "OpenCode Design", message: "Design canvas stopped.", variant: "success", duration: 3000 });
  listener({ ...event, id: "replayed-event", data: event.data });
  assert.equal(shown.length, 1, "same inbox admission cannot show twice under another event ID");
  listener({ ...withMetadata({ ...metadata, stopped: false }), data: { ...withMetadata({ ...metadata, stopped: false }).data, inboxID: "inbox-two" } });
  assert.equal(shown.length, 1, "stopping an inactive canvas does not show a toast");

  cleanup(); assert.equal(removed, true);
  setupStopToast(ctx); listener(event);
  assert.equal(shown.length, 1, "reload retains deduplication memory");
});
