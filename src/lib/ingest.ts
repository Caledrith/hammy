import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Database } from "../db";
import {
  bomComponents,
  channelListings,
  orderLineItems,
  orders,
  printJobs,
  productRecipes,
  syncState,
} from "../db/schema";
import { getAdapter } from "./channels";
import type { Channel, ChannelAdapter, NormalizedLineItem } from "./channels/types";
import { resolveLineItem, type ResolveResult } from "./recipes/engine";
import { DEFAULT_RULESET, type LineItemInput } from "./recipes/types";

// First-run lookback so we don't pull the entire order history on a fresh DB.
const DEFAULT_LOOKBACK_DAYS = 7;
// Re-scan a window before the saved cursor each run. Shopify's `updated_at`
// bumps on any edit and orders can share a boundary timestamp, so overlapping
// guards against skipping an order that landed right at the last cursor. Upserts
// are idempotent, so re-fetching this window is free.
const SYNC_OVERLAP_MS = 10 * 60_000;
const CANCELLABLE_JOB_STATUSES = ["pending", "ready", "needs_review", "assigned"] as const;

export interface SyncResult {
  ordersProcessed: number;
  lineItemsResolved: number;
  jobsCreated: number;
  needsReview: number;
  cancelledJobs: number;
}

function syncKeyFor(channel: Channel): string {
  return `orders:${channel}`;
}

function toLineItemInput(li: NormalizedLineItem): LineItemInput {
  return {
    productHandle: li.productHandle,
    sku: li.sku,
    variantTitle: li.variantTitle,
    quantity: li.quantity,
    properties: li.properties,
  };
}

// ---------------------------------------------------------------------------
// Product identity + recipe resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a channel-native product to an internal product key:
 *   channel_listings(channel, external_key) -> product_key,
 *   falling back to the product handle, then the SKU.
 * This is where cross-channel identity (Shopify handle / Amazon ASIN / eBay SKU)
 * collapses to one internal product.
 */
export async function resolveProductKey(
  db: Database,
  channel: Channel,
  handle: string | null,
  sku: string | null,
): Promise<string | null> {
  const candidates = [handle, sku].filter((v): v is string => !!v);
  for (const key of candidates) {
    const [row] = await db
      .select({ productKey: channelListings.productKey })
      .from(channelListings)
      .where(and(eq(channelListings.channel, channel), eq(channelListings.externalKey, key)))
      .limit(1);
    if (row) return row.productKey;
  }
  return handle ?? sku ?? null;
}

/** Find a recipe by trying each key in order against product_recipes.key. */
async function findRecipe(db: Database, keys: (string | null)[]) {
  const unique = [...new Set(keys.filter((v): v is string => !!v))];
  for (const key of unique) {
    const [row] = await db
      .select()
      .from(productRecipes)
      .where(eq(productRecipes.key, key))
      .limit(1);
    if (row) return row;
  }
  return null;
}

/** Persist resolved jobs + BOM for a line item (replaces any existing rows). */
async function writeResolution(
  db: Database,
  lineItemId: number,
  result: ResolveResult,
  productKey: string | null,
): Promise<{ jobsCreated: number; needsReview: number }> {
  await db.delete(printJobs).where(eq(printJobs.orderLineItemId, lineItemId));
  await db.delete(bomComponents).where(eq(bomComponents.orderLineItemId, lineItemId));

  if (result.jobs.length > 0) {
    await db.insert(printJobs).values(
      result.jobs.map((j) => ({
        orderLineItemId: lineItemId,
        partType: j.partType,
        printableFileId: j.printableFileId,
        opticModel: j.opticModel,
        quantity: j.quantity,
        materialOption: j.materialOption,
        colorOption: j.colorOption,
        filamentMaterial: j.filamentMaterial,
        colorHex: j.colorHex,
        slicerProfile: j.slicerProfile,
        status: j.status,
        reviewReason: j.reviewReason,
        reviewKind: j.reviewKind,
      })),
    );
  }

  if (result.bom.length > 0) {
    await db.insert(bomComponents).values(
      result.bom.map((b) => ({
        orderLineItemId: lineItemId,
        kind: b.kind,
        ref: b.ref,
        quantity: b.quantity,
      })),
    );
  }

  await db
    .update(orderLineItems)
    .set({ resolutionStatus: result.resolutionStatus, productKey, updatedAt: new Date() })
    .where(eq(orderLineItems.id, lineItemId));

  const needsReview = result.jobs.filter((j) => j.status === "needs_review").length;
  return { jobsCreated: result.jobs.length, needsReview };
}

async function resolveAndWrite(
  db: Database,
  lineItemId: number,
  channel: Channel,
  li: LineItemInput,
): Promise<{ jobsCreated: number; needsReview: number }> {
  const productKey = await resolveProductKey(db, channel, li.productHandle, li.sku);
  // No explicit recipe -> fall back to the single-part default handler so the
  // product still resolves to a plate-ready job when material/color are known.
  const recipe = await findRecipe(db, [productKey, li.productHandle, li.sku]);
  const ruleSet = recipe?.ruleSet ?? DEFAULT_RULESET;
  const result = await resolveLineItem(db, ruleSet, li);
  return writeResolution(db, lineItemId, result, productKey);
}

/**
 * Re-run resolution for a single stored line item (used by the dashboard after
 * an optic alias is added or a manual re-resolve is requested).
 */
export async function reprocessLineItem(lineItemId: number): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({
      id: orderLineItems.id,
      productHandle: orderLineItems.productHandle,
      sku: orderLineItems.sku,
      variantTitle: orderLineItems.variantTitle,
      quantity: orderLineItems.quantity,
      properties: orderLineItems.properties,
      channel: orders.channel,
    })
    .from(orderLineItems)
    .leftJoin(orders, eq(orderLineItems.orderId, orders.id))
    .where(eq(orderLineItems.id, lineItemId))
    .limit(1);
  if (!row) throw new Error(`Line item ${lineItemId} not found`);

  const li: LineItemInput = {
    productHandle: row.productHandle,
    sku: row.sku,
    variantTitle: row.variantTitle,
    quantity: row.quantity,
    properties: row.properties,
  };
  await resolveAndWrite(db, lineItemId, (row.channel ?? "shopify") as Channel, li);
}

/** Distinct line-item ids that still have needs_review jobs for a product. */
export async function needsReviewLineItemIdsForProduct(productKey: string): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ id: printJobs.orderLineItemId })
    .from(printJobs)
    .innerJoin(orderLineItems, eq(printJobs.orderLineItemId, orderLineItems.id))
    .where(and(eq(printJobs.status, "needs_review"), eq(orderLineItems.productKey, productKey)));
  return rows.map((r) => r.id);
}

/** Sequentially re-run resolution for a set of line items. */
export async function reprocessLineItems(ids: number[]): Promise<void> {
  for (const id of ids) await reprocessLineItem(id);
}

/**
 * Pull orders from one channel and turn them into print jobs.
 *
 * Idempotent: upserts on (channel, external_id); only resolves line items that
 * don't yet have print jobs (so manual overrides survive re-syncs). Cancels jobs
 * for cancelled / refunded orders.
 */
export async function syncChannel(
  adapter: ChannelAdapter,
  options: { since?: Date; full?: boolean; maxPages?: number } = {},
): Promise<SyncResult> {
  const db = getDb();
  const channel = adapter.channel;
  const result: SyncResult = {
    ordersProcessed: 0,
    lineItemsResolved: 0,
    jobsCreated: 0,
    needsReview: 0,
    cancelledJobs: 0,
  };

  const key = syncKeyFor(channel);
  const [state] = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  const firstRunDefault = options.full
    ? undefined
    : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  const cursor = state?.lastSyncedAt
    ? new Date(state.lastSyncedAt.getTime() - SYNC_OVERLAP_MS)
    : undefined;
  const since = options.since ?? cursor ?? firstRunDefault;

  const channelOrders = await adapter.fetchOrders({ since, maxPages: options.maxPages });
  let newestUpdatedAt = state?.lastSyncedAt ?? null;

  for (const no of channelOrders) {
    if (no.channelUpdatedAt && (!newestUpdatedAt || no.channelUpdatedAt > newestUpdatedAt)) {
      newestUpdatedAt = no.channelUpdatedAt;
    }

    // Upsert order (conflict on the channel-agnostic natural key).
    const [orderRow] = await db
      .insert(orders)
      .values({
        channel,
        externalId: no.externalId,
        name: no.name,
        email: no.email,
        customerName: no.customerName,
        financialStatus: no.financialStatus,
        fulfillmentStatus: no.fulfillmentStatus,
        currency: no.currency,
        totalPrice: no.totalPrice,
        totalDiscounts: no.totalDiscounts,
        discountCodes: no.discountCodes,
        cancelledAt: no.cancelledAt,
        processedAt: no.processedAt,
        channelUpdatedAt: no.channelUpdatedAt,
        shipping: no.shipping,
        raw: no.raw,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [orders.channel, orders.externalId],
        set: {
          name: no.name,
          email: no.email,
          customerName: no.customerName,
          financialStatus: no.financialStatus,
          fulfillmentStatus: no.fulfillmentStatus,
          currency: no.currency,
          totalPrice: no.totalPrice,
          totalDiscounts: no.totalDiscounts,
          discountCodes: no.discountCodes,
          cancelledAt: no.cancelledAt,
          channelUpdatedAt: no.channelUpdatedAt,
          shipping: no.shipping,
          raw: no.raw,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ id: orders.id });

    const orderId = orderRow.id;
    result.ordersProcessed += 1;

    for (const li of no.lineItems) {
      const [liRow] = await db
        .insert(orderLineItems)
        .values({
          orderId,
          externalId: li.externalId,
          title: li.title,
          sku: li.sku,
          productHandle: li.productHandle,
          variantId: li.variantId,
          variantTitle: li.variantTitle,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          properties: li.properties,
        })
        .onConflictDoUpdate({
          target: orderLineItems.externalId,
          set: {
            title: li.title,
            sku: li.sku,
            productHandle: li.productHandle,
            variantTitle: li.variantTitle,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            properties: li.properties,
            updatedAt: new Date(),
          },
        })
        .returning({ id: orderLineItems.id });

      const lineItemId = liRow.id;

      // Cancel jobs for cancelled / refunded orders.
      if (no.isCancelled) {
        const cancelledRows = await db
          .update(printJobs)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(printJobs.orderLineItemId, lineItemId),
              inArray(printJobs.status, [...CANCELLABLE_JOB_STATUSES]),
            ),
          )
          .returning({ id: printJobs.id });
        result.cancelledJobs += cancelledRows.length;
        continue;
      }

      if (!no.isPaid) continue;

      // Only resolve line items that don't already have jobs (preserve overrides).
      const existing = await db
        .select({ id: printJobs.id })
        .from(printJobs)
        .where(eq(printJobs.orderLineItemId, lineItemId))
        .limit(1);
      if (existing.length > 0) continue;

      const { jobsCreated, needsReview } = await resolveAndWrite(
        db,
        lineItemId,
        channel,
        toLineItemInput(li),
      );
      result.lineItemsResolved += 1;
      result.jobsCreated += jobsCreated;
      result.needsReview += needsReview;
    }
  }

  // Advance the per-channel sync cursor.
  await db
    .insert(syncState)
    .values({ key, lastSyncedAt: newestUpdatedAt ?? new Date(), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { lastSyncedAt: newestUpdatedAt ?? new Date(), updatedAt: new Date() },
    });

  return result;
}

/**
 * Backwards-compatible entry point: sync the Shopify channel. Kept so existing
 * scripts / the dashboard "Sync now" button keep working.
 */
export async function syncOrders(
  options: { since?: Date; full?: boolean; maxPages?: number } = {},
): Promise<SyncResult> {
  return syncChannel(getAdapter("shopify"), options);
}
