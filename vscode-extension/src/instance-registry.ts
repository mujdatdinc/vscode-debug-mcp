import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-window bridge registry.
 *
 * Each VS Code window publishes its own bridge (identity + real port + token)
 * so a launcher process can find "the bridge of the window I belong to"
 * instead of assuming a single fixed port.
 *
 * Registry location: `%TEMP%/vscode-debug-mcp/instances.json`
 * (override with the `VSCODE_DEBUG_REGISTRY_DIR` environment variable; the MCP
 * server reads the same file, so both sides must agree on this variable).
 */

/** One published bridge, owned by one VS Code window. */
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

/**
 * Identity of this VS Code window (the extension host it runs in).
 * Prefers the per-extension-host IPC key, which is the most specific signal
 * available to both the extension and a process it spawns.
 */
export function instanceId(): string {
  const extHost = process.env.VSCODE_IPC_HOOK_EXTHOST?.trim();
  if (extHost) {
    return `exthost:${crypto.createHash("sha1").update(extHost).digest("hex").slice(0, 16)}`;
  }
  const mainPid = process.env.VSCODE_PID?.trim();
  if (mainPid) return `vscodepid:${mainPid}`;
  return `exthostpid:${process.pid}`;
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readAll(): Record<string, BridgeInstance> {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, BridgeInstance>;
    }
  } catch {
    // Missing or unreadable registry — start from an empty one.
  }
  return {};
}

function writeAll(all: Record<string, BridgeInstance>): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  fs.renameSync(tmp, REGISTRY_FILE);
}

/**
 * Publishes this window's bridge and prunes rows left behind by closed windows.
 * Returns the record that was written.
 */
export function publish(entry: Omit<BridgeInstance, "id" | "updatedAt">): BridgeInstance {
  const all = readAll();
  for (const [key, value] of Object.entries(all)) {
    if (!isAlive(value.pid)) delete all[key];
  }

  const record: BridgeInstance = {
    id: instanceId(),
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  all[record.id] = record;
  writeAll(all);
  return record;
}

/** Removes this window's row (called when the bridge stops or the window closes). */
export function unpublish(): void {
  const all = readAll();
  delete all[instanceId()];
  try {
    writeAll(all);
  } catch {
    // The window is going away; a stale row is pruned by the next publish().
  }
}
