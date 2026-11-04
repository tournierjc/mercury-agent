import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the tools installed from the phone live — and nothing else.
 *
 * This file exists on its own because two callers need the path and only one of them may drag a
 * child-process import into its graph: `sandbox/tools.ts` spawns installers, while the argv lane
 * only wants a directory to search. Keeping the path here means the lane can ask without pulling
 * `spawn` behind it (which broke a test that mocks `node:child_process`).
 *
 * The location is inside the mounted `~/.mercury`, so an installed tool survives a container
 * upgrade; `MERCURY_TOOLS_DIR` exists so a test can point it at a scratch directory.
 */
export function toolsDir(): string {
  return process.env.MERCURY_TOOLS_DIR?.trim() || join(homedir(), '.mercury', 'tools');
}

/** The `bin/` inside [toolsDir] — the one directory put on the daemon's PATH. */
export function toolsPath(): string {
  return join(toolsDir(), 'bin');
}
