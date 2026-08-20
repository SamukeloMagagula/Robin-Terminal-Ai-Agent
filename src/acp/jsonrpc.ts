/**
 * The bare JSON-RPC 2.0 envelope ACP rides on — independent of ACP's own
 * methods. Genuinely bidirectional: the editor sends requests Robin must
 * answer (initialize, session/new, session/prompt), and Robin sends requests
 * the editor must answer (session/request_permission). Both directions need
 * the same "is this a request/notification/response" classification.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number | string; result: unknown }
  | { jsonrpc: '2.0'; id: number | string; error: { code: number; message: string } };

// Predicates narrow to an intersection with the input type, not the bare
// named interfaces above — a plain `Record<string, unknown>` is not
// generally assignable to a type with concretely-typed fields like
// `id: number | string`, which is exactly what TS's type-predicate
// assignability check requires of the parameter type.

export function isRequest(
  msg: Record<string, unknown>
): msg is Record<string, unknown> & { id: number | string; method: string } {
  return typeof msg.method === 'string' && (typeof msg.id === 'string' || typeof msg.id === 'number');
}

export function isNotification(
  msg: Record<string, unknown>
): msg is Record<string, unknown> & { method: string } {
  return typeof msg.method === 'string' && msg.id === undefined;
}

export function isResponse(
  msg: Record<string, unknown>
): msg is Record<string, unknown> & { id: number | string } & (
    | { result: unknown }
    | { error: { code: number; message: string } }
  ) {
  if (typeof msg.method === 'string') return false;
  if (msg.id === undefined) return false;
  return msg.result !== undefined || msg.error !== undefined;
}
