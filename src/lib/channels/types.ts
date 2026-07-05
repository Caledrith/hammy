import type { LineItemProperty } from "../../db/schema";

/** Sales channels an order can originate from. Mirrors the `order_channel` enum. */
export type Channel = "shopify" | "amazon" | "ebay";

/**
 * Channel-agnostic line item. The recipe engine already operates on a shape like
 * this (see LineItemInput), so adapters normalize their native payloads into it.
 */
export interface NormalizedLineItem {
  /** Channel-native line-item id (stored as order_line_items.external_id). */
  externalId: string;
  title: string | null;
  sku: string | null;
  /** Channel-native product key (Shopify handle, Amazon ASIN, eBay SKU, ...). */
  productHandle: string | null;
  variantId: string | null;
  variantTitle: string | null;
  quantity: number;
  properties: LineItemProperty[];
}

/** Channel-agnostic order. */
export interface NormalizedOrder {
  channel: Channel;
  /** Channel-native order id (stored as orders.external_id). */
  externalId: string;
  name: string | null;
  email: string | null;
  customerName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string | null;
  cancelledAt: Date | null;
  processedAt: Date | null;
  /** Channel-native "last updated" timestamp, drives the incremental cursor. */
  channelUpdatedAt: Date | null;
  shipping: unknown;
  /** Raw channel payload, retained for debugging / reprocessing. */
  raw: unknown;
  /** Channel-specific status semantics, resolved by the adapter. */
  isPaid: boolean;
  isCancelled: boolean;
  lineItems: NormalizedLineItem[];
}

export interface FetchOrdersOptions {
  /** Only return orders updated on/after this instant (incremental sync). */
  since?: Date;
  maxPages?: number;
}

/**
 * A channel adapter knows how to pull orders from one sales channel and return
 * them in the normalized shape. Ingestion is written against this interface, so
 * adding Amazon/eBay is a matter of implementing `fetchOrders`.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  fetchOrders(options?: FetchOrdersOptions): Promise<NormalizedOrder[]>;
}
