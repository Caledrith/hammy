import { z } from "zod";

const envSchema = z.object({
  SHOPIFY_CLIENT_ID: z.string().min(1, "SHOPIFY_CLIENT_ID is required"),
  SHOPIFY_SECRET: z.string().min(1, "SHOPIFY_SECRET is required"),
  SHOPIFY_STORE: z
    .string()
    .min(1, "SHOPIFY_STORE is required (e.g. your-store.myshopify.com)"),
  SHOPIFY_API_VERSION: z.string().min(1).default("2026-07"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Shared secret the slicer worker presents on /api/worker/* calls. Optional so
  // builds and non-worker deployments don't require it; the worker routes reject
  // requests when it is unset.
  WORKER_TOKEN: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validates and returns environment variables lazily.
 *
 * Lazy (rather than validating at import time) so that `next build` and modules
 * that only touch part of the config don't crash when unrelated vars are absent.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
