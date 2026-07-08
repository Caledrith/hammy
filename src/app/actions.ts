"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { filamentMap, opticAliases, orderLineItems, printJobs, productRecipes } from "@/db/schema";
import {
  needsReviewLineItemIdsForProduct,
  reprocessLineItem,
  reprocessLineItems,
} from "@/lib/ingest";
import { composePlates } from "@/lib/plates/compose";
import { normalizeOptic } from "@/lib/recipes/normalize";
import { DEFAULT_RULESET, ruleSetSchema } from "@/lib/recipes/types";

const VALID_STATUSES = [
  "pending",
  "ready",
  "needs_review",
  "assigned",
  "printing",
  "done",
  "failed",
  "cancelled",
] as const;
type JobStatus = (typeof VALID_STATUSES)[number];

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath("/review");
  revalidatePath("/orders");
  revalidatePath("/plates");
  revalidatePath("/print");
}

export async function updateJobStatus(formData: FormData) {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status"));
  if (!id || !VALID_STATUSES.includes(status as JobStatus)) return;
  const db = getDb();
  await db
    .update(printJobs)
    .set({ status: status as JobStatus, updatedAt: new Date() })
    .where(eq(printJobs.id, id));
  revalidateAll();
}

/** Basic mode: mark every ready job in an order as manually put on a printer. */
export async function markOrderReadyJobsPrinting(formData: FormData) {
  const orderId = Number(formData.get("orderId"));
  if (!orderId) return;
  const db = getDb();
  const lineItems = await db
    .select({ id: orderLineItems.id })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId));
  const ids = lineItems.map((l) => l.id);
  if (ids.length === 0) return;
  await db
    .update(printJobs)
    .set({ status: "printing", updatedAt: new Date() })
    .where(and(inArray(printJobs.orderLineItemId, ids), eq(printJobs.status, "ready")));
  revalidateAll();
}

/** Basic mode: mark every ready job of one filament (material + color) as put on a printer. */
export async function markFilamentReadyJobsPrinting(formData: FormData) {
  const material = String(formData.get("material") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();
  if (!material || !color) return;
  const db = getDb();
  await db
    .update(printJobs)
    .set({ status: "printing", updatedAt: new Date() })
    .where(
      and(
        eq(printJobs.materialOption, material),
        eq(printJobs.colorOption, color),
        eq(printJobs.status, "ready"),
      ),
    );
  revalidateAll();
}

/** Basic mode: mark every on-printer job in an order as printed (done). */
export async function markOrderPrintingJobsDone(formData: FormData) {
  const orderId = Number(formData.get("orderId"));
  if (!orderId) return;
  const db = getDb();
  const lineItems = await db
    .select({ id: orderLineItems.id })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId));
  const ids = lineItems.map((l) => l.id);
  if (ids.length === 0) return;
  await db
    .update(printJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(and(inArray(printJobs.orderLineItemId, ids), eq(printJobs.status, "printing")));
  revalidateAll();
}

/** Basic mode: mark every on-printer job of one filament (material + color) as printed (done). */
export async function markFilamentPrintingJobsDone(formData: FormData) {
  const material = String(formData.get("material") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();
  if (!material || !color) return;
  const db = getDb();
  await db
    .update(printJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(
      and(
        eq(printJobs.materialOption, material),
        eq(printJobs.colorOption, color),
        eq(printJobs.status, "printing"),
      ),
    );
  revalidateAll();
}

export async function setJobPriority(formData: FormData) {
  const id = Number(formData.get("id"));
  const priority = Number(formData.get("priority"));
  if (!id || !Number.isFinite(priority)) return;
  const db = getDb();
  await db
    .update(printJobs)
    .set({ priority, updatedAt: new Date() })
    .where(eq(printJobs.id, id));
  revalidatePath("/queue");
}

export async function addOpticAlias(formData: FormData) {
  const source = String(formData.get("source") ?? "").trim();
  const canonical = String(formData.get("canonical") ?? "").trim();
  const productKey = String(formData.get("productKey") ?? "").trim();
  if (!source || !canonical) return;

  const db = getDb();
  await db
    .insert(opticAliases)
    .values({
      normalizedSource: normalizeOptic(source),
      sourceString: source,
      canonicalOptic: canonical,
    })
    .onConflictDoUpdate({
      target: opticAliases.normalizedSource,
      set: { canonicalOptic: canonical, sourceString: source },
    });

  if (productKey) await reprocessLineItems(await needsReviewLineItemIdsForProduct(productKey));
  revalidateAll();
}

export async function setProductFilamentDefault(formData: FormData) {
  const productKey = String(formData.get("productKey") ?? "").trim();
  const productName = String(formData.get("productName") ?? "").trim();
  const material = String(formData.get("material") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();
  if (!productKey || !material || !color) return;

  const db = getDb();
  const [filament] = await db
    .select({ id: filamentMap.id })
    .from(filamentMap)
    .where(and(eq(filamentMap.materialOption, material), eq(filamentMap.colorOption, color)))
    .limit(1);
  if (!filament) return;

  const [existingRecipe] = await db
    .select()
    .from(productRecipes)
    .where(eq(productRecipes.key, productKey))
    .limit(1);

  const currentRuleSet = existingRecipe
    ? ruleSetSchema.parse(existingRecipe.ruleSet)
    : DEFAULT_RULESET;
  const ruleSet = { ...currentRuleSet, defaultMaterial: material, defaultColor: color };
  const name = existingRecipe?.name ?? productName ?? productKey;

  await db
    .insert(productRecipes)
    .values({ key: productKey, name, ruleSet })
    .onConflictDoUpdate({
      target: productRecipes.key,
      set: { name, ruleSet, updatedAt: new Date() },
    });

  await reprocessLineItems(await needsReviewLineItemIdsForProduct(productKey));
  revalidateAll();
}

export async function reResolveLineItem(formData: FormData) {
  const lineItemId = Number(formData.get("lineItemId"));
  if (!lineItemId) return;
  await reprocessLineItem(lineItemId);
  revalidateAll();
}

export async function reResolveProduct(formData: FormData) {
  const productKey = String(formData.get("productKey") ?? "").trim();
  if (!productKey) return;
  await reprocessLineItems(await needsReviewLineItemIdsForProduct(productKey));
  revalidateAll();
}

/**
 * Compose the ready jobs of one plate group into draft plates for the slicer
 * worker to pick up. `groupKey` is the exact key the /plates page computes.
 */
export async function composePlatesForGroup(formData: FormData) {
  const groupKey = String(formData.get("groupKey") ?? "").trim();
  if (!groupKey) return;
  await composePlates(groupKey);
  revalidatePath("/plates");
}
