import type { Plugin } from "@opencode/plugin/tui";
import { setupStopToast } from "./stop-toast.ts";

// The host validates this shape (id + setup); importing the runtime helper
// would pull in the TUI's Solid dependencies, which a plugin package cannot
// resolve on its own.
export default { id: "opencode-design.tui", setup: setupStopToast } satisfies Plugin.Definition;
