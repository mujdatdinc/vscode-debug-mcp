import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { DebugController } from "./debug-controller";

// Read from the manifest so /health can be used to confirm which build is live
// after reinstalling the extension.
const { version: EXTENSION_VERSION } = require("../package.json") as { version: string };

/**
 * HTTP bridge server that exposes DebugController methods as REST endpoints.
 * Runs on localhost only — never exposed externally.
 * The MCP server communicates with this server to control VSCode debugging.
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

        const url = req.url ?? "";

        // When a token is configured, every route except /health requires it.
        // The bridge can change program state, so knowing the port must not be
        // enough for any other local process to drive the debugger.
        if (this.token && url !== "/health" && req.headers["x-bridge-token"] !== this.token) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        try {
          const body = await readBody(req);
          const result = await this.route(req.method ?? "", url, body);
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
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
    url: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    // Health check
    if (url === "/health" && method === "GET") {
      return { status: "ok", version: EXTENSION_VERSION };
    }

    // Debug state
    if (url === "/state" && method === "GET") {
      return this.controller.getState();
    }

    // Breakpoint operations
    if (url === "/breakpoint" && method === "POST") {
      return this.controller.setBreakpoint(
        requireString(body, "file"),
        requireNumber(body, "line"),
        {
          condition: body.condition as string | undefined,
          hitCondition: body.hitCondition as string | undefined,
          logMessage: body.logMessage as string | undefined,
        },
      );
    }

    if (url === "/breakpoint" && method === "DELETE") {
      return this.controller.removeBreakpoint(
        requireString(body, "file"),
        requireNumber(body, "line"),
      );
    }

    if (url === "/breakpoints" && method === "GET") {
      return this.controller.listBreakpoints();
    }

    // Debug session control
    if (url === "/debug/launch" && method === "POST") {
      const config = body.configName
        ? (body.configName as string)
        : (body.config as import("vscode").DebugConfiguration);
      if (!config) {
        throw new RouteError(400, "Provide either configName or config");
      }
      return this.controller.launchDebug(config);
    }

    if (url === "/debug/stop" && method === "POST") {
      return this.controller.stopDebugging();
    }

    // Stepping
    if (url === "/debug/continue" && method === "POST") {
      return this.controller.continue_();
    }
    if (url === "/debug/stepOver" && method === "POST") {
      return this.controller.stepOver();
    }
    if (url === "/debug/stepInto" && method === "POST") {
      return this.controller.stepInto();
    }
    if (url === "/debug/stepOut" && method === "POST") {
      return this.controller.stepOut();
    }
    if (url === "/debug/pause" && method === "POST") {
      return this.controller.pause();
    }

    // Inspection
    if (url === "/debug/callstack" && method === "GET") {
      return this.controller.getCallStack();
    }

    if (url === "/debug/variables" && method === "POST") {
      return this.controller.getVariables(
        body.frameId as number | undefined,
        body.scope as string | undefined,
      );
    }

    if (url === "/debug/evaluate" && method === "POST") {
      return this.controller.evaluate(
        requireString(body, "expression"),
        body.frameId as number | undefined,
        body.context as string | undefined,
      );
    }

    if (url === "/debug/expand" && method === "POST") {
      return this.controller.expandVariable(
        requireNumber(body, "variablesReference"),
      );
    }

    if (url === "/debug/threads" && method === "GET") {
      return this.controller.getThreads();
    }

    throw new RouteError(404, `Unknown route: ${method} ${url}`);
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
