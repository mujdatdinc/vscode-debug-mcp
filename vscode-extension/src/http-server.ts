import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  AmbiguousSessionsError,
  DebugController,
  SessionNotFoundError,
  type SessionSelection,
} from "./debug-controller";

// Read from the manifest so /health can be used to confirm which build is live
// after reinstalling the extension.
const { version: EXTENSION_VERSION } = require("../package.json") as { version: string };

/**
 * HTTP bridge server that exposes DebugController methods as REST endpoints.
 * Runs on localhost only — never exposed externally.
 * The MCP server communicates with this server to control VSCode debugging.
 *
 * Every route accepts an optional `sessionId` (and, where it matters, `threadId`)
 * either in the JSON body or as a query parameter, so a caller can pick which
 * debug session to drive. `GET /sessions` lists the live sessions.
 *
 * @example
 * const server = new BridgeServer(controller, 7779);
 * await server.start();
 * // POST http://localhost:7779/breakpoint { file, line }
 * await server.stop();
 */
export class BridgeServer {
  private server: http.Server | null = null;
  private actualPort: number | null = null;

  constructor(
    private controller: DebugController,
    private port: number,
    private readonly token?: string,
  ) {}

  /**
   * The port actually bound. Differs from the requested port when `0`
   * (ephemeral) was requested because the configured port was already taken.
   */
  get boundPort(): number {
    return this.actualPort ?? this.port;
  }

  /**
   * Starts the HTTP server on localhost.
   * Routes are mapped to DebugController methods.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");

        const parsedUrl = new URL(req.url ?? "", "http://127.0.0.1");

        // When a token is configured, every route except /health requires it.
        // The bridge can change program state, so knowing the port must not be
        // enough for any other local process to drive the debugger.
        if (
          this.token &&
          parsedUrl.pathname !== "/health" &&
          req.headers["x-bridge-token"] !== this.token
        ) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        try {
          const body = await readBody(req);
          const result = await this.route(
            req.method ?? "",
            parsedUrl.pathname,
            parsedUrl.searchParams,
            body,
          );
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            res.writeHead(404);
            res.end(
              JSON.stringify({
                error: err.message,
                code: "session_not_found",
                candidates: err.candidates,
              }),
            );
            return;
          }
          if (err instanceof AmbiguousSessionsError) {
            res.writeHead(409);
            res.end(
              JSON.stringify({
                error: err.message,
                code: "ambiguous_sessions",
                candidates: err.candidates,
              }),
            );
            return;
          }
          const statusCode = err instanceof RouteError ? err.statusCode : 500;
          res.writeHead(statusCode);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.actualPort = (this.server?.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server gracefully.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.actualPort = null;
        resolve();
      });
    });
  }

  private async route(
    method: string,
    pathname: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const sel = readSelection(body, query);

    // Health check
    if (pathname === "/health" && method === "GET") {
      return { status: "ok", version: EXTENSION_VERSION };
    }

    // Live debug sessions — pick one to control
    if (pathname === "/sessions" && method === "GET") {
      return this.controller.listSessions();
    }

    // Debug state
    if (pathname === "/state" && method === "GET") {
      return this.controller.getState(sel);
    }

    // Breakpoint operations
    if (pathname === "/breakpoint" && method === "POST") {
      return this.controller.setBreakpoint(
        requireString(body, "file"),
        requireNumber(body, "line"),
        {
          condition: body.condition as string | undefined,
          hitCondition: body.hitCondition as string | undefined,
          logMessage: body.logMessage as string | undefined,
          sessionId: sel.sessionId,
        },
      );
    }

    if (pathname === "/breakpoint" && method === "DELETE") {
      return this.controller.removeBreakpoint(
        requireString(body, "file"),
        requireNumber(body, "line"),
        sel.sessionId,
      );
    }

    if (pathname === "/breakpoints" && method === "GET") {
      return this.controller.listBreakpoints();
    }

    // Debug session control
    if (pathname === "/debug/launch" && method === "POST") {
      const config = body.configName
        ? (body.configName as string)
        : (body.config as import("vscode").DebugConfiguration);
      if (!config) {
        throw new RouteError(400, "Provide either configName or config");
      }
      return this.controller.launchDebug(config);
    }

    if (pathname === "/debug/stop" && method === "POST") {
      return this.controller.stopDebugging(sel);
    }

    // Stepping
    if (pathname === "/debug/continue" && method === "POST") {
      return this.controller.continue_(sel);
    }
    if (pathname === "/debug/stepOver" && method === "POST") {
      return this.controller.stepOver(sel);
    }
    if (pathname === "/debug/stepInto" && method === "POST") {
      return this.controller.stepInto(sel);
    }
    if (pathname === "/debug/stepOut" && method === "POST") {
      return this.controller.stepOut(sel);
    }
    if (pathname === "/debug/pause" && method === "POST") {
      return this.controller.pause(sel);
    }

    // Inspection
    if (pathname === "/debug/callstack" && method === "GET") {
      return this.controller.getCallStack(sel);
    }

    if (pathname === "/debug/variables" && method === "POST") {
      return this.controller.getVariables(
        body.frameId as number | undefined,
        body.scope as string | undefined,
        sel,
      );
    }

    if (pathname === "/debug/evaluate" && method === "POST") {
      return this.controller.evaluate(
        requireString(body, "expression"),
        body.frameId as number | undefined,
        body.context as string | undefined,
        sel,
      );
    }

    if (pathname === "/debug/expand" && method === "POST") {
      return this.controller.expandVariable(
        requireNumber(body, "variablesReference"),
        sel,
      );
    }

    if (pathname === "/debug/threads" && method === "GET") {
      return this.controller.getThreads(sel);
    }

    throw new RouteError(404, `Unknown route: ${method} ${pathname}`);
  }
}

class RouteError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads an optional session/thread selector from the request body, falling back
 * to the `sessionId`/`threadId` query parameters.
 */
function readSelection(
  body: Record<string, unknown>,
  query: URLSearchParams,
): SessionSelection {
  const bodySession = body.sessionId;
  const sessionId =
    typeof bodySession === "string" && bodySession.length > 0
      ? bodySession
      : query.get("sessionId") ?? undefined;

  const threadId = parseThreadId(body.threadId) ?? parseThreadId(query.get("threadId"));

  const sel: SessionSelection = {};
  if (sessionId) sel.sessionId = sessionId;
  if (threadId !== undefined) sel.threadId = threadId;
  return sel;
}

/** Accepts a number or a numeric string; anything else yields undefined. */
function parseThreadId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const val = body[key];
  if (typeof val !== "string") {
    throw new RouteError(400, `Missing required string field: ${key}`);
  }
  return val;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const val = body[key];
  if (typeof val !== "number") {
    throw new RouteError(400, `Missing required number field: ${key}`);
  }
  return val;
}
