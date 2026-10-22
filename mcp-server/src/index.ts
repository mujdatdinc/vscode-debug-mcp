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
import { VSCodeClient } from "./vscode-client.js";
import { describeInstances, registryFilePath, resolveInstance } from "./registry.js";

const server = new McpServer({
  name: "vscode-debugger",
  version: "0.1.1",
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

// ─── Tools ───────────────────────────────────────────────────────────

server.tool(
  "get_debug_state",
  "Get the current debug state (inactive, running, or stopped at breakpoint)",
  {},
  async () => {
    const client = await resolveClient();
    const state = await client.get("/state");
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  },
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
  },
  async ({ file, line, condition, hitCondition, logMessage }) => {
    const client = await resolveClient();
    const result = await client.post("/breakpoint", { file, line, condition, hitCondition, logMessage });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "remove_breakpoint",
  "Remove all breakpoints at a specific file and line number",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().int().positive().describe("Line number (1-indexed)"),
  },
  async ({ file, line }) => {
    const client = await resolveClient();
    const result = await client.delete("/breakpoint", { file, line });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "list_breakpoints",
  "List all currently set breakpoints with their file paths, line numbers, and conditions",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.get("/breakpoints");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
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
  async ({ configName, config }) => {
    const client = await resolveClient();
    const body: Record<string, unknown> = {};
    if (configName) body.configName = configName;
    if (config) body.config = config;
    const result = await client.post("/debug/launch", body);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "stop_debugging",
  "Stop the currently active debug session",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/stop");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "debug_continue",
  "Continue execution (resume from a breakpoint or pause)",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/continue");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "debug_step_over",
  "Step over the next statement (execute without entering function calls)",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/stepOver");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "debug_step_into",
  "Step into the next function call",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/stepInto");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "debug_step_out",
  "Step out of the current function (return to caller)",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/stepOut");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "debug_pause",
  "Pause execution of the running program",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.post("/debug/pause");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_call_stack",
  "Get the current call stack (list of stack frames with file paths and line numbers)",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.get("/debug/callstack");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_variables",
  "Get variables in the current scope. Optionally specify a frame ID and scope name.",
  {
    frameId: z.number().int().optional().describe("Stack frame ID (from get_call_stack). Defaults to the top frame."),
    scope: z.string().optional().describe("Scope name filter (e.g., 'Local', 'Global', 'Closure'). Shows all scopes if omitted."),
  },
  async ({ frameId, scope }) => {
    const client = await resolveClient();
    const result = await client.post("/debug/variables", { frameId, scope });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "evaluate_expression",
  "Evaluate an expression in the context of the current debug frame. Useful for inspecting values, calling methods, or testing conditions.",
  {
    expression: z.string().describe("Expression to evaluate (e.g., 'myVar.length', 'arr.filter(x => x > 0)')"),
    frameId: z.number().int().optional().describe("Stack frame ID to evaluate in. Defaults to the top frame."),
    context: z.enum(["watch", "repl", "hover"]).optional().describe("Evaluation context. 'repl' allows side effects, 'watch' is read-only, 'hover' is for tooltips."),
  },
  async ({ expression, frameId, context }) => {
    const client = await resolveClient();
    const result = await client.post("/debug/evaluate", { expression, frameId, context });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "expand_variable",
  "Expand a complex variable (object, array) to see its child properties. Use the variablesReference from get_variables or evaluate_expression.",
  {
    variablesReference: z.number().int().describe("The variablesReference ID of the variable to expand (from get_variables or evaluate_expression results)"),
  },
  async ({ variablesReference }) => {
    const client = await resolveClient();
    const result = await client.post("/debug/expand", { variablesReference });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_threads",
  "List all threads in the current debug session",
  {},
  async () => {
    const client = await resolveClient();
    const result = await client.get("/debug/threads");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
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
