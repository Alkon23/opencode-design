import { statSync, symlinkSync } from "node:fs";

/** Windows directory junctions need no Developer Mode. File symlinks may still require it. */
export function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, statSync(target).isDirectory() && process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}
