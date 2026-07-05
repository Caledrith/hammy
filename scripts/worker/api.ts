import type {
  ClaimResponse,
  CompleteRequest,
  FailRequest,
} from "../../src/lib/worker/types";
import type { WorkerConfig } from "./config";

async function postJson(
  config: WorkerConfig,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${config.serverUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.workerToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Claim the next queued plate, or null when the queue is empty. */
export async function claimPlate(config: WorkerConfig): Promise<ClaimResponse> {
  const res = await postJson(config, "/api/worker/claim");
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ClaimResponse;
}

export async function completePlate(
  config: WorkerConfig,
  plateId: number,
  body: CompleteRequest,
): Promise<void> {
  const res = await postJson(config, `/api/worker/plates/${plateId}/complete`, body);
  if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`);
}

export async function failPlate(
  config: WorkerConfig,
  plateId: number,
  body: FailRequest,
): Promise<void> {
  const res = await postJson(config, `/api/worker/plates/${plateId}/fail`, body);
  if (!res.ok) throw new Error(`fail report failed: ${res.status} ${await res.text()}`);
}
