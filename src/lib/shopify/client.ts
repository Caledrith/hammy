import { getEnv } from "../env";
import { getAccessToken } from "./token";

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
  extensions?: unknown;
}

/**
 * Execute a GraphQL query against the Shopify Admin API using a client-credentials
 * access token. Throws on HTTP errors and on GraphQL `errors`.
 */
export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { SHOPIFY_STORE, SHOPIFY_API_VERSION } = getEnv();
  const token = await getAccessToken();

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Shopify GraphQL request failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  if (!json.data) {
    throw new Error("Shopify GraphQL response contained no data");
  }
  return json.data;
}
