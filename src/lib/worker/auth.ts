import { getEnv } from "../env";

/**
 * Result of authenticating a worker request. When `ok` is false, `response`
 * carries the exact JSON error + status the route should return.
 */
export type WorkerAuth =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Validate the `Authorization: Bearer <token>` header against WORKER_TOKEN.
 *
 * Returns a structured result rather than throwing so route handlers can return
 * a clean JSON error. A missing server-side token is a 503 (misconfiguration),
 * a missing/bad client token is a 401.
 */
export function checkWorkerAuth(request: Request): WorkerAuth {
  const expected = getEnv().WORKER_TOKEN;
  if (!expected) {
    return { ok: false, status: 503, error: "WORKER_TOKEN is not configured on the server" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1]?.trim();
  if (!presented || presented !== expected) {
    return { ok: false, status: 401, error: "Invalid or missing worker token" };
  }

  return { ok: true };
}
