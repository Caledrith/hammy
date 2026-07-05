import { AmazonAdapter } from "./amazon";
import { EbayAdapter } from "./ebay";
import { ShopifyAdapter } from "./shopify";
import type { Channel, ChannelAdapter } from "./types";

/** Factory per channel so ingestion can sync any channel by name. */
export const adapterFactories: Record<Channel, () => ChannelAdapter> = {
  shopify: () => new ShopifyAdapter(),
  amazon: () => new AmazonAdapter(),
  ebay: () => new EbayAdapter(),
};

export function getAdapter(channel: Channel): ChannelAdapter {
  return adapterFactories[channel]();
}

export { ShopifyAdapter, AmazonAdapter, EbayAdapter };
export type {
  Channel,
  ChannelAdapter,
  FetchOrdersOptions,
  NormalizedLineItem,
  NormalizedOrder,
} from "./types";
