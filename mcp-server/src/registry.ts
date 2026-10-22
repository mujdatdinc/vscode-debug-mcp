import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Reads the per-window bridge registry written by the Debug MCP Bridge extension.
 *
 * The registry lets this server pick the bridge of the VS Code window it was
 * launched from instead of assuming a single fixed port. When the owning window
 * cannot be determined unambiguously, resolution fails instead of guessing —
 * driving another window's debugger is worse than an error.
 *
 * Registry location: `%TEMP%/vscode-debug-mcp/instances.json`
 * (override with `VSCODE_DEBUG_REGISTRY_DIR`; must match the extension's value).
 */

/** A live published bridge. */
export interface BridgeInstance {
  id: string;
  pid: number;
  port: number;
  token: string;
  workspaceFolders: string[];
  host: string;
  updatedAt: string;
}

const REGISTRY_DIR =
  process.env.VSCODE_DEBUG_REGISTRY_DIR?.trim() ||
  path.join(os.tmpdir(), "vscode-debug-mcp");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "instances.json");

export function registryFilePath(): string {
  return REGISTRY_FILE;
}

/** Identity of the window this process belongs to, if the environment reveals it. */
function instanceIdFromEnv(): string | null {
  const extHost = process.env.VSCODE_IPC_HOOK_EXTHOST?.trim();
  if (extHost) {
    return `exthost:${crypto.createHash("sha1").update(extHost).digest("hex").slice(0, 16)}`;
  }
  const mainPid = process.env.VSCODE_PID?.trim();
  if (mainPid) return `vscodepid:${mainPid}`;
  return null;
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Published instances whose owning window is still alive. */
export function readInstances(): BridgeInstance[] {
  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_FILE, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, BridgeInstance>;
    return Object.values(parsed).filter((entry) => entry && isAlive(entry.pid));
  } catch {
    return [];
  }
}

/**
 * Resolves the bridge belonging to this process's VS Code window.
 * Returns null when there is no bridge, or when more than one is registered and
 * none matches this window — ambiguity must surface as an error, not a guess.
 */
export function resolveInstance(): BridgeInstance | null {
  const instances = readInstances();

  const forcedId = process.env.VSCODE_DEBUG_REGISTRY_ENTRY?.trim();
  if (forcedId) {
    return instances.find((entry) => entry.id === forcedId) ?? null;
  }

  const ownId = instanceIdFromEnv();
  if (ownId) {
    const own = instances.find((entry) => entry.id === ownId);
    if (own) return own;
  }

  return instances.length === 1 ? instances[0] : null;
}

/** Human-readable instance list, for error messages. */
export function describeInstances(): string {
  const instances = readInstances();
  if (instances.length === 0) {
    return `  (none registered — registry: ${REGISTRY_FILE})`;
  }
  return instances
    .map(
      (entry) =>
        `  ${entry.id}  port=${entry.port}  pid=${entry.pid}  folders=${entry.workspaceFolders.join(", ") || "(none)"}`,
    )
    .join("\n");
}
