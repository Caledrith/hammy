"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  channelListings,
  filamentMap,
  opticAliases,
  orderLineItems,
  orders,
  printJobs,
  productRecipes,
} from "@/db/schema";
import { reprocessLineItem, syncOrders } from "@/lib/ingest";
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
  const lineItemId = Number(formData.get("lineItemId"));
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

  if (lineItemId) await reprocessLineItem(lineItemId);
  revalidateAll();
}

export async function setLineItemFilamentDefault(formData: FormData) {
  const lineItemId = Number(formData.get("lineItemId"));
  const material = String(formData.get("material") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();
  if (!lineItemId || !material || !color) return;

  const db = getDb();
  const [filament] = await db
    .select({ id: filamentMap.id })
    .from(filamentMap)
    .where(and(eq(filamentMap.materialOption, material), eq(filamentMap.colorOption, color)))
    .limit(1);
  if (!filament) return;

  const [lineItem] = await db
    .select({
      productHandle: orderLineItems.productHandle,
      sku: orderLineItems.sku,
      title: orderLineItems.title,
      channel: orders.channel,
    })
    .from(orderLineItems)
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(eq(orderLineItems.id, lineItemId))
    .limit(1);
  if (!lineItem) return;

  let productKey: string | null = null;
  if (lineItem.channel) {
    const listingCandidates = [lineItem.productHandle, lineItem.sku].filter(
      (v): v is string => !!v,
    );
    for (const externalKey of listingCandidates) {
      const [listing] = await db
        .select({ productKey: channelListings.productKey })
        .from(channelListings)
        .where(
          and(
            eq(channelListings.channel, lineItem.channel),
            eq(channelListings.externalKey, externalKey),
          ),
        )
        .limit(1);
      if (listing) {
        productKey = listing.productKey;
        break;
      }
    }
  }

  const recipeKeys = [
    ...new Set(
      [productKey, lineItem.productHandle, lineItem.sku].filter((v): v is string => !!v),
    ),
  ];
  let existingRecipe: typeof productRecipes.$inferSelect | null = null;
  for (const key of recipeKeys) {
    const [recipe] = await db
      .select()
      .from(productRecipes)
      .where(eq(productRecipes.key, key))
      .limit(1);
    if (recipe) {
      existingRecipe = recipe;
      break;
    }
  }

  const key = existingRecipe?.key ?? productKey ?? lineItem.productHandle ?? lineItem.sku;
  if (!key) return;

  const currentRuleSet = existingRecipe
    ? ruleSetSchema.parse(existingRecipe.ruleSet)
    : DEFAULT_RULESET;
  const ruleSet = { ...currentRuleSet, defaultMaterial: material, defaultColor: color };
  const name = existingRecipe?.name ?? lineItem.title ?? key;

  await db
    .insert(productRecipes)
    .values({ key, name, ruleSet })
    .onConflictDoUpdate({
      target: productRecipes.key,
      set: { name, ruleSet, updatedAt: new Date() },
    });

  await reprocessLineItem(lineItemId);
  revalidateAll();
}

export async function reResolveLineItem(formData: FormData) {
  const lineItemId = Number(formData.get("lineItemId"));
  if (!lineItemId) return;
  await reprocessLineItem(lineItemId);
  revalidateAll();
}

export async function runSync() {
  await syncOrders();
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
