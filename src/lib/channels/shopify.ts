import {
  fetchAllOrders,
  type ShopifyLineItem,
  type ShopifyOrder,
} from "../shopify/orders";
import type {
  ChannelAdapter,
  FetchOrdersOptions,
  NormalizedLineItem,
  NormalizedOrder,
} from "./types";

// Shopify financial-status semantics.
const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED"];
const CANCELLED_STATUSES = ["REFUNDED", "VOIDED"];

function customerName(order: ShopifyOrder): string | null {
  const first = order.customer?.firstName ?? "";
  const last = order.customer?.lastName ?? "";
  const full = `${first} ${last}`.trim();
  return full || order.shippingAddress?.name || null;
}

function normalizeLineItem(li: ShopifyLineItem): NormalizedLineItem {
  return {
    externalId: li.id,
    title: li.title,
    sku: li.sku,
    productHandle: li.product?.handle ?? null,
    variantId: li.variant?.id ?? null,
    variantTitle: li.variant?.title ?? null,
    quantity: li.quantity,
    unitPrice: li.originalUnitPriceSet?.shopMoney.amount ?? null,
    properties: li.customAttributes.map((a) => ({ name: a.key, value: a.value })),
  };
}

function normalizeOrder(so: ShopifyOrder): NormalizedOrder {
  const isCancelled =
    so.cancelledAt != null ||
    (so.displayFinancialStatus != null &&
      CANCELLED_STATUSES.includes(so.displayFinancialStatus));
  const isPaid =
    so.displayFinancialStatus != null && PAID_STATUSES.includes(so.displayFinancialStatus);

  return {
    channel: "shopify",
    externalId: so.id,
    name: so.name,
    email: so.email,
    customerName: customerName(so),
    financialStatus: so.displayFinancialStatus,
    fulfillmentStatus: so.displayFulfillmentStatus,
    currency: so.currencyCode,
    totalPrice: so.totalPriceSet?.shopMoney.amount ?? null,
    totalDiscounts: so.totalDiscountsSet?.shopMoney.amount ?? null,
    discountCodes: so.discountCodes ?? [],
    cancelledAt: so.cancelledAt ? new Date(so.cancelledAt) : null,
    processedAt: so.processedAt ? new Date(so.processedAt) : null,
    channelUpdatedAt: so.updatedAt ? new Date(so.updatedAt) : null,
    shipping: so.shippingAddress ?? null,
    raw: so,
    isPaid,
    isCancelled,
    lineItems: so.lineItems.nodes.map(normalizeLineItem),
  };
}

export class ShopifyAdapter implements ChannelAdapter {
  readonly channel = "shopify" as const;

  async fetchOrders(options: FetchOrdersOptions = {}): Promise<NormalizedOrder[]> {
    // Shopify search syntax: no quotes around the ISO timestamp.
    const query = options.since ? `updated_at:>=${options.since.toISOString()}` : undefined;
    // Drain the whole window (bounded by `since`). A high safety ceiling avoids
    // runaway loops without silently dropping the oldest orders in the window,
    // which is what caused syncs to skip a chunk of the previous day.
    const orders = await fetchAllOrders({
      query,
      first: 50,
      maxPages: options.maxPages ?? 200,
    });
    console.log(`[shopify] fetched ${orders.length} orders${query ? ` (${query})` : ""}`);
    return orders.map(normalizeOrder);
  }
}
