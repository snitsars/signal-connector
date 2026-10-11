/**
 * Minimal JSON-RPC 2.0 client for the signal-cli daemon HTTP endpoint.
 */
export interface RpcError {
  code: number;
  message: string;
}

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: RpcError;
}

let nextId = 1;

export async function jsonRpc<T>(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = (await response.json()) as RpcResponse<T>;
  if (body.error) {
    throw new Error(`signal-cli ${method} failed: ${body.error.message}`);
  }
  return body.result as T;
}
