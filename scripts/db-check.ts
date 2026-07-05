import "dotenv/config";
import postgres from "postgres";

/**
 * Read-only connectivity check. Confirms DATABASE_URL works and lists existing
 * public tables so we can spot collisions before creating our schema. Does not
 * print the connection string and does not modify anything.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  try {
    const [{ db, version }] = await sql<{ db: string; version: string }[]>`
      select current_database() as db, version() as version
    `;
    console.log(`Connected to database: ${db}`);
    console.log(`Server: ${version.split(",")[0]}`);

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    if (tables.length === 0) {
      console.log("\nNo existing tables in public schema (clean).");
    } else {
      console.log(`\nExisting public tables (${tables.length}):`);
      for (const t of tables) console.log(`  - ${t.table_name}`);
    }

    const ours = [
      "orders",
      "order_line_items",
      "product_recipes",
      "channel_listings",
      "printable_files",
      "part_variants",
      "optic_aliases",
      "filament_map",
      "print_jobs",
      "bom_components",
      "sync_state",
    ];
    const collisions = tables.map((t) => t.table_name).filter((n) => ours.includes(n));
    if (collisions.length > 0) {
      console.log(`\nWARNING: name collisions with hammy tables: ${collisions.join(", ")}`);
    } else {
      console.log("\nNo collisions with hammy table names.");
    }
  } finally {
    await sql.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\ndb-check failed:\n", err);
    process.exit(1);
  });
