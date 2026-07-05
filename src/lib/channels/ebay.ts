import type { ChannelAdapter, NormalizedOrder } from "./types";

/**
 * Placeholder for the eBay Sell Fulfillment API integration. Satisfies the
 * ChannelAdapter interface; pulling orders is not yet implemented. When built,
 * this will normalize eBay order line items (seller SKU -> internal product via
 * channel_listings).
 */
export class EbayAdapter implements ChannelAdapter {
  readonly channel = "ebay" as const;

  async fetchOrders(): Promise<NormalizedOrder[]> {
    throw new Error("eBay channel adapter is not implemented yet");
  }
}
