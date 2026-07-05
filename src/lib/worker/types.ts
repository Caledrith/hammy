// Wire contract between the server's /api/worker/* routes and the shop-PC
// slicer worker. Kept free of server-only imports (db, env) so the worker
// script can import these types directly.

/** One printable part to place on the plate, with how many copies. */
export interface ClaimFile {
  printJobId: number;
  /** Library-relative, forward-slashed path (resolve against MODELS_ROOT). */
  path: string;
  partType: string;
  quantity: number;
  /** Human label for logs (order/product), best-effort. */
  label: string | null;
}

/** Everything the worker needs to slice one plate. */
export interface ClaimedPlate {
  id: number;
  material: string | null;
  color: string | null;
  nozzle: number;
  plateType: string | null;
  slicerProfile: string | null;
  targetPrinterModel: string | null;
  files: ClaimFile[];
}

/** Response of POST /api/worker/claim. `plate` is null when nothing is queued. */
export interface ClaimResponse {
  plate: ClaimedPlate | null;
}

/** Body of POST /api/worker/plates/:id/complete. */
export interface CompleteRequest {
  estMinutes?: number | null;
  estGrams?: number | null;
  objectCount?: number | null;
  artifactFilename?: string | null;
}

/** Body of POST /api/worker/plates/:id/fail. */
export interface FailRequest {
  reason: string;
  /** Tail of CLI stderr / diagnostic detail. */
  detail?: string | null;
}
