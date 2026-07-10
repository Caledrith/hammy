/**
 * Next.js runs this once per server process on startup. We use it to launch the
 * background autosync scheduler (Node runtime only, never Edge).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAutoSync } = await import("./lib/auto-sync");
  startAutoSync();
}
