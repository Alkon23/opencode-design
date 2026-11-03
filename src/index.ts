import { Plugin } from "@opencode/plugin";
import { setupDesign } from "./plugin.ts";

export default Plugin.define({ id: "opencode-design", setup: setupDesign });
