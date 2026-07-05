import type { ChannelAdapter, NormalizedOrder } from "./types";

/**
 * Placeholder for the Amazon SP-API integration. It satisfies the ChannelAdapter
 * interface so ingestion can be wired for Amazon, but pulling orders is not yet
 * implemented. When built, this will call the Orders API and normalize items
 * (ASIN -> internal product via channel_listings).
 */
export class AmazonAdapter implements ChannelAdapter {
  readonly channel = "amazon" as const;

  async fetchOrders(): Promise<NormalizedOrder[]> {
    throw new Error("Amazon channel adapter is not implemented yet");
  }
}
