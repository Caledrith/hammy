import { shopifyGraphQL } from "./client";

export interface ShopifyLineItem {
  id: string;
  title: string;
  quantity: number;
  sku: string | null;
  variant: { id: string; title: string | null } | null;
  product: { id: string; handle: string | null } | null;
  /** Line-item properties (from variant options apps / custom fields). */
  customAttributes: { key: string; value: string }[];
}

export interface ShopifyAddress {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currencyCode: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  shippingAddress: ShopifyAddress | null;
  lineItems: { nodes: ShopifyLineItem[] };
}

interface OrdersQueryResult {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyOrder[];
  };
}

const ORDER_FIELDS = /* GraphQL */ `
  id
  name
  email
  createdAt
  updatedAt
  processedAt
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  currencyCode
  customer { firstName lastName }
  shippingAddress { name address1 address2 city province zip country }
  lineItems(first: 100) {
    nodes {
      id
      title
      quantity
      sku
      variant { id title }
      product { id handle }
      customAttributes { key value }
    }
  }
`;

const ORDERS_QUERY = /* GraphQL */ `
  query Orders($first: Int!, $query: String, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

export interface FetchOrdersOptions {
  first?: number;
  /** Shopify search query, e.g. "financial_status:paid updated_at:>'2024-01-01'". */
  query?: string;
  after?: string;
}

export async function fetchOrdersPage(
  options: FetchOrdersOptions = {},
): Promise<OrdersQueryResult["orders"]> {
  const { first = 50, query, after } = options;
  const data = await shopifyGraphQL<OrdersQueryResult>(ORDERS_QUERY, {
    first,
    query: query ?? null,
    after: after ?? null,
  });
  return data.orders;
}

/**
 * Fetch all orders matching a query, following pagination. `maxPages` guards
 * against runaway loops.
 */
export async function fetchAllOrders(
  options: FetchOrdersOptions & { maxPages?: number } = {},
): Promise<ShopifyOrder[]> {
  const { maxPages = 50, ...rest } = options;
  const all: ShopifyOrder[] = [];
  let after: string | undefined = rest.after;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchOrdersPage({ ...rest, after });
    all.push(...result.nodes);
    if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) break;
    after = result.pageInfo.endCursor;
  }
  return all;
}

/** Convenience: most recent N orders (any status), newest first. */
export async function fetchRecentOrders(limit = 5): Promise<ShopifyOrder[]> {
  const result = await fetchOrdersPage({ first: limit });
  return result.nodes;
}
