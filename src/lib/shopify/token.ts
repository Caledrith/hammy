import { getEnv } from "../env";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

interface ClientCredentialsResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Mint (or return cached) Admin API access token via the client-credentials grant.
 *
 * Tokens are short-lived (~24h). We cache in memory and refresh ~60s before expiry.
 * Only works when the app + store are in the same Shopify organization and the app
 * is installed on the store; otherwise Shopify returns `shop_not_permitted`.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 60_000) {
    return cache.token;
  }

  const { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_SECRET } = getEnv();

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Shopify token request failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const data = (await res.json()) as ClientCredentialsResponse;
  const ttlMs = (data.expires_in ?? 86_400) * 1000;
  cache = { token: data.access_token, expiresAt: now + ttlMs };
  return data.access_token;
}

/** Clear the cached token (useful for tests / forced refresh). */
export function resetTokenCache(): void {
  cache = null;
}
