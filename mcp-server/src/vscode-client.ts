/**
 * HTTP client that communicates with the VSCode Debug MCP Bridge extension.
 * Sends requests to the extension's HTTP server running on localhost.
 *
 * @example
 * const client = new VSCodeClient(7779, token);
 * const state = await client.get("/state");
 * await client.post("/breakpoint", { file: "app.ts", line: 10 });
 */
export class VSCodeClient {
  private baseUrl: string;

  constructor(
    port: number = 7779,
    private readonly token?: string,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** Request headers, including the per-window bridge token when known. */
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { "x-bridge-token": this.token } : {}),
    };
  }

  /**
   * Sends a GET request to the extension bridge server.
   */
  async get<T = unknown>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bridge request failed (${response.status}): ${body}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Sends a POST request with a JSON body to the extension bridge server.
   */
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bridge request failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Sends a DELETE request with a JSON body to the extension bridge server.
   */
  async delete<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bridge request failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Checks if the bridge extension is reachable.
   */
  async isConnected(): Promise<boolean> {
    try {
      await this.get("/health");
      return true;
    } catch {
      return false;
    }
  }
}
