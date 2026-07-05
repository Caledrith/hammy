import "dotenv/config";
import { fetchRecentOrders } from "../src/lib/shopify/orders";

/**
 * Milestone 1 verification gate.
 *
 * Fetches recent orders and prints, per line item, the SKU, variant title, and
 * customAttributes (line-item properties). This reveals whether the "Optic"
 * (scope model) and other options arrive as native variants (variant title) or
 * as line-item properties (an options app) - which decides recipe matching.
 */
async function main() {
  const limit = Number(process.argv[2] ?? 5);
  console.log(`Fetching ${limit} most recent orders...\n`);

  const orders = await fetchRecentOrders(limit);
  if (orders.length === 0) {
    console.log("No orders found.");
    return;
  }

  for (const order of orders) {
    console.log("=".repeat(72));
    console.log(
      `Order ${order.name}  (${order.displayFinancialStatus ?? "?"} / ${
        order.displayFulfillmentStatus ?? "?"
      })  processed=${order.processedAt ?? "-"}`,
    );
    for (const li of order.lineItems.nodes) {
      console.log(`\n  Line item: ${li.title}  x${li.quantity}`);
      console.log(`    sku:            ${li.sku ?? "(none)"}`);
      console.log(`    product.handle: ${li.product?.handle ?? "(none)"}`);
      console.log(`    variant.title:  ${li.variant?.title ?? "(none)"}`);
      if (li.customAttributes.length === 0) {
        console.log(`    customAttributes: (none)`);
      } else {
        console.log(`    customAttributes:`);
        for (const attr of li.customAttributes) {
          console.log(`      - ${attr.key}: ${attr.value}`);
        }
      }
    }
    console.log();
  }

  console.log("=".repeat(72));
  console.log(
    "\nInterpretation:\n" +
      "  - If options (Optic/Material/Color/Style/Killflash) appear under\n" +
      "    variant.title  -> they are native Shopify variants.\n" +
      "  - If they appear under customAttributes -> they come from an options app\n" +
      "    (line-item properties). The recipe engine reads both.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\ninspect-orders failed:\n", err);
    process.exit(1);
  });
