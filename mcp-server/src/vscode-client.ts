/**
 * HTTP client that communicates with the VSCode Debug MCP Bridge extension.
 * Sends requests to the extension's HTTP server running on localhost.
 *
 * @example
 * const client = new VSCodeClient(7779, token);
 * const state = await client.get("/state");
 * await client.post("/breakpoint", { file: "app.ts", line: 10 });
 */

/**
 * Error raised for a non-2xx bridge response. Carries the HTTP `status` and the
 * parsed response `body` alongside the historical message text, so callers can
 * react to structured error codes (e.g. `session_not_found`,
 * `ambiguous_sessions`) without breaking existing `Error` handling.
 */
export class BridgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

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

  /** Parses a failed response into a {@link BridgeError}, keeping the legacy message. */
  private async bridgeError(response: Response): Promise<BridgeError> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON — keep the raw text as the body.
    }
    return new BridgeError(
      response.status,
      body,
      `Bridge request failed (${response.status}): ${text}`,
    );
  }

  /**
   * Sends a GET request to the extension bridge server.
   * Optional `query` values are appended as query parameters.
   */
  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      throw await this.bridgeError(response);
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
      throw await this.bridgeError(response);
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
      throw await this.bridgeError(response);
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
