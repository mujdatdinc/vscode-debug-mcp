#!/usr/bin/env node

/**
 * MCP Server for VSCode Debugging.
 * Exposes debugging operations (breakpoints, stepping, inspection) as MCP tools.
 * Communicates with the VSCode Debug MCP Bridge extension via HTTP.
 *
 * @example
 * // Configure in Claude Code settings:
 * // { "mcpServers": { "vscode-debugger": { "command": "node", "args": ["dist/index.js"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, VSCodeClient } from "./vscode-client.js";
import { describeInstances, registryFilePath, resolveInstance } from "./registry.js";

const server = new McpServer({
  name: "vscode-debugger",
  version: "0.2.0",
});

// ─── Bridge resolution ───────────────────────────────────────────────

let connected: VSCodeClient | null = null;

function parsePort(value: string | undefined): number | null {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the bridge of the VS Code window this server was launched from.
 * Re-resolves whenever the cached client stops answering, so a bridge that
 * starts or restarts later is picked up without restarting this server.
 */
async function resolveClient(): Promise<VSCodeClient> {
  if (connected && (await connected.isConnected())) return connected;

  const forcedPort = parsePort(process.env.VSCODE_DEBUG_BRIDGE_PORT);
  if (forcedPort) {
    const forced = new VSCodeClient(forcedPort, process.env.VSCODE_DEBUG_BRIDGE_TOKEN?.trim());
    if (!(await forced.isConnected())) {
      throw new Error(`No Debug MCP Bridge answering on fixed port ${forcedPort}.`);
    }
    connected = forced;
    return forced;
  }

  const instance = resolveInstance();
  if (!instance) {
    throw new Error(
      "Cannot determine which VS Code window this server belongs to.\n" +
        "Registered bridges:\n" +
        describeInstances() +
        "\nSet VSCODE_DEBUG_REGISTRY_ENTRY to one of the ids above, " +
        "or VSCODE_DEBUG_BRIDGE_PORT to force a port.",
    );
  }

  const client = new VSCodeClient(instance.port, instance.token);
  if (!(await client.isConnected())) {
    throw new Error(
      `Bridge ${instance.id} is registered on port ${instance.port} but is not answering. ` +
        "Start it from the Command Palette: 'Debug MCP Bridge: Start Server'.",
    );
  }

  console.error(`vscode-debug-mcp: using bridge ${instance.id} on port ${instance.port}`);
  connected = client;
  return client;
}

// ─── Tool result helpers ─────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Runs a tool body and serializes its result. A structured bridge failure
 * (`ambiguous_sessions` / `session_not_found`) becomes a human-readable message
 * that lists the candidates and asks for a `sessionId`; any other error is
 * rethrown so it keeps the existing SDK error behaviour.
 */
async function runTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const friendly = describeBridgeError(err);
    if (friendly) return friendly;
    throw err;
  }
}

/** Maps a structured 409/404 bridge error to a readable tool result, else null. */
function describeBridgeError(err: unknown): ToolResult | null {
  if (!(err instanceof BridgeError)) return null;
  const body = (err.body ?? {}) as { code?: string; candidates?: unknown };

  if (err.status === 409 && body.code === "ambiguous_sessions") {
    const candidates = (Array.isArray(body.candidates) ? body.candidates : []) as Array<{
      id: string;
      name: string;
      threadIds: number[];
    }>;
    const lines = candidates.map(
      (c) => `- ${c.id}  (name: ${c.name}, paused threads: ${c.threadIds.join(", ") || "none"})`,
    );
    return {
      content: [
        {
          type: "text",
          text:
            "Multiple debug sessions are paused, so the target is ambiguous.\n" +
            "Pass one of these as sessionId (see get_sessions):\n" +
            lines.join("\n"),
        },
      ],
    };
  }

  if (err.status === 404 && body.code === "session_not_found") {
    const candidates = (Array.isArray(body.candidates) ? body.candidates : []) as string[];
    return {
      content: [
        {
          type: "text",
          text:
            "No debug session with that sessionId. Known session ids: " +
            `${candidates.length > 0 ? candidates.join(", ") : "(none)"}. ` +
            "Pick one (see get_sessions) and pass it as sessionId.",
        },
      ],
    };
  }

  return null;
}

/** Reusable optional selector params for the session-scoped tools. */
const sessionIdParam = z
  .string()
  .optional()
  .describe("Debug session id to control (from get_sessions). Omit to use the active/only paused session.");
const threadIdParam = z
  .number()
  .int()
  .optional()
  .describe("Thread id within the chosen session (from get_sessions). Omit to use the session's first paused thread.");

// ─── Tools ───────────────────────────────────────────────────────────

server.tool(
  "get_sessions",
  "List every live debug session (id, name, type, parentId, paused, threadIds). Use it to pick the session to control, then pass its id to the other tools.",
  {},
  async () =>
    runTool(async () => {
      const client = await resolveClient();
      return client.get("/sessions");
    }),
);

server.tool(
  "get_debug_state",
  "Get the current debug state (inactive, running, or stopped at breakpoint)",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.get("/state", { sessionId });
    }),
);

server.tool(
  "set_breakpoint",
  "Set a breakpoint at a specific file and line number. Optionally add a condition expression.",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().int().positive().describe("Line number (1-indexed)"),
    condition: z.string().optional().describe("Conditional expression — breakpoint only hits when this evaluates to true"),
    hitCondition: z.string().optional().describe("Hit count expression — breakpoint hits after this many passes"),
    logMessage: z.string().optional().describe("Log message instead of breaking (logpoint). Use {expression} for interpolation."),
    sessionId: sessionIdParam,
  },
  async ({ file, line, condition, hitCondition, logMessage, sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/breakpoint", { file, line, condition, hitCondition, logMessage, sessionId });
    }),
);

server.tool(
  "remove_breakpoint",
  "Remove all breakpoints at a specific file and line number",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().int().positive().describe("Line number (1-indexed)"),
    sessionId: sessionIdParam,
  },
  async ({ file, line, sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.delete("/breakpoint", { file, line, sessionId });
    }),
);

server.tool(
  "list_breakpoints",
  "List all currently set breakpoints with their file paths, line numbers, and conditions",
  {},
  async () =>
    runTool(async () => {
      const client = await resolveClient();
      return client.get("/breakpoints");
    }),
);

server.tool(
  "launch_debug",
  "Start a debug session. Provide either a launch.json config name or an inline debug configuration object.",
  {
    configName: z.string().optional().describe("Name of a launch configuration from .vscode/launch.json"),
    config: z.object({
      type: z.string().describe("Debugger type (e.g., 'node', 'python', 'cppdbg')"),
      request: z.enum(["launch", "attach"]).describe("Launch or attach to a process"),
      name: z.string().describe("Configuration name"),
      program: z.string().optional().describe("Path to the program to debug"),
      args: z.array(z.string()).optional().describe("Command-line arguments"),
      cwd: z.string().optional().describe("Working directory"),
      env: z.record(z.string()).optional().describe("Environment variables"),
      runtimeExecutable: z.string().optional().describe("Runtime executable (e.g., 'node', 'python')"),
      runtimeArgs: z.array(z.string()).optional().describe("Arguments for the runtime executable"),
      port: z.number().optional().describe("Port to attach to (for attach requests)"),
      stopOnEntry: z.boolean().optional().describe("Stop at the first line of the program"),
    }).optional().describe("Inline debug configuration"),
  },
  async ({ configName, config }) =>
    runTool(async () => {
      const client = await resolveClient();
      const body: Record<string, unknown> = {};
      if (configName) body.configName = configName;
      if (config) body.config = config;
      return client.post("/debug/launch", body);
    }),
);

server.tool(
  "stop_debugging",
  "Stop the currently active (or selected) debug session",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/stop", { sessionId });
    }),
);

server.tool(
  "debug_continue",
  "Continue execution (resume from a breakpoint or pause)",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/continue", { sessionId });
    }),
);

server.tool(
  "debug_step_over",
  "Step over the next statement (execute without entering function calls)",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/stepOver", { sessionId });
    }),
);

server.tool(
  "debug_step_into",
  "Step into the next function call",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/stepInto", { sessionId });
    }),
);

server.tool(
  "debug_step_out",
  "Step out of the current function (return to caller)",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/stepOut", { sessionId });
    }),
);

server.tool(
  "debug_pause",
  "Pause execution of the running program",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/pause", { sessionId });
    }),
);

server.tool(
  "get_call_stack",
  "Get the current call stack (list of stack frames with file paths and line numbers)",
  {
    sessionId: sessionIdParam,
    threadId: threadIdParam,
  },
  async ({ sessionId, threadId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.get("/debug/callstack", { sessionId, threadId });
    }),
);

server.tool(
  "get_variables",
  "Get variables in the current scope. Optionally specify a frame ID and scope name.",
  {
    frameId: z.number().int().optional().describe("Stack frame ID (from get_call_stack). Defaults to the top frame."),
    scope: z.string().optional().describe("Scope name filter (e.g., 'Local', 'Global', 'Closure'). Shows all scopes if omitted."),
    sessionId: sessionIdParam,
    threadId: threadIdParam,
  },
  async ({ frameId, scope, sessionId, threadId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/variables", { frameId, scope, sessionId, threadId });
    }),
);

server.tool(
  "evaluate_expression",
  "Evaluate an expression in the context of the current debug frame. Useful for inspecting values, calling methods, or testing conditions.",
  {
    expression: z.string().describe("Expression to evaluate (e.g., 'myVar.length', 'arr.filter(x => x > 0)')"),
    frameId: z.number().int().optional().describe("Stack frame ID to evaluate in. Defaults to the top frame."),
    context: z.enum(["watch", "repl", "hover"]).optional().describe("Evaluation context. 'repl' allows side effects, 'watch' is read-only, 'hover' is for tooltips."),
    sessionId: sessionIdParam,
    threadId: threadIdParam,
  },
  async ({ expression, frameId, context, sessionId, threadId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/evaluate", { expression, frameId, context, sessionId, threadId });
    }),
);

server.tool(
  "expand_variable",
  "Expand a complex variable (object, array) to see its child properties. Use the variablesReference from get_variables or evaluate_expression.",
  {
    variablesReference: z.number().int().describe("The variablesReference ID of the variable to expand (from get_variables or evaluate_expression results)"),
    sessionId: sessionIdParam,
  },
  async ({ variablesReference, sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.post("/debug/expand", { variablesReference, sessionId });
    }),
);

server.tool(
  "get_threads",
  "List all threads in the current debug session",
  {
    sessionId: sessionIdParam,
  },
  async ({ sessionId }) =>
    runTool(async () => {
      const client = await resolveClient();
      return client.get("/debug/threads", { sessionId });
    }),
);

// ─── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`VSCode Debug MCP Server running on stdio (registry: ${registryFilePath()})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
