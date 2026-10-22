import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { DebugController } from "./debug-controller";
import { BridgeServer } from "./http-server";
import { publish, unpublish } from "./instance-registry";

let bridgeServer: BridgeServer | null = null;
const debugController = new DebugController();

/**
 * Extension activation entry point.
 * Starts the HTTP bridge server and registers debug event listeners.
 *
 * The server prefers the configured port but falls back to an ephemeral one
 * when that port is taken, so several windows can run side by side. The real
 * port and a per-window token are published to the instance registry, so a
 * launcher process can find the bridge of the window it belongs to.
 */
export function activate(context: vscode.ExtensionContext): void {
  debugController.activate(context);

  const startOn = async (port: number, token: string): Promise<BridgeServer> => {
    const server = new BridgeServer(debugController, port, token);
    await server.start();
    return server;
  };

  const startServer = async () => {
    if (bridgeServer) {
      vscode.window.showInformationMessage("Debug MCP Bridge is already running.");
      return;
    }

    const config = vscode.workspace.getConfiguration("debugMcpBridge");
    const preferredPort = config.get<number>("port", 7779);
    const allowPortFallback = config.get<boolean>("allowPortFallback", true);
    const token = crypto.randomBytes(24).toString("hex");

    try {
      try {
        bridgeServer = await startOn(preferredPort, token);
      } catch (err) {
        if (!allowPortFallback) throw err;
        bridgeServer = await startOn(0, token);
        vscode.window.showWarningMessage(
          `Debug MCP Bridge: port ${preferredPort} is in use, listening on ${bridgeServer.boundPort} instead.`,
        );
      }

      publish({
        pid: process.pid,
        port: bridgeServer.boundPort,
        token,
        host: "127.0.0.1",
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
          (folder) => folder.uri.fsPath,
        ),
      });

      vscode.window.showInformationMessage(
        `Debug MCP Bridge started on port ${bridgeServer.boundPort}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to start Debug MCP Bridge: ${err}`,
      );
      bridgeServer = null;
    }
  };

  const stopServer = async () => {
    if (!bridgeServer) {
      vscode.window.showInformationMessage("Debug MCP Bridge is not running.");
      return;
    }
    await bridgeServer.stop();
    bridgeServer = null;
    unpublish();
    vscode.window.showInformationMessage("Debug MCP Bridge stopped.");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("debugMcpBridge.start", startServer),
    vscode.commands.registerCommand("debugMcpBridge.stop", stopServer),
  );

  // Auto-start on activation
  startServer();
}

/**
 * Extension deactivation — stops the bridge server and removes its registry row.
 */
export function deactivate(): void {
  if (bridgeServer) {
    bridgeServer.stop();
    bridgeServer = null;
  }
  unpublish();
}
