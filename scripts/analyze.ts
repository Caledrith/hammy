import "dotenv/config";
import postgres from "postgres";

/** One-off read-only analysis of the current queue to guide catalog buildout. */
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const categories = await sql<{ category: string; n: number }[]>`
      select
        case
          when review_reason like 'No product recipe%' then 'no_recipe'
          when review_reason like '%no model file%' then 'no_model_file'
          when review_reason like '%no filament mapping%' then 'no_filament'
          when review_reason like 'No BOM rule%' then 'no_bom_rule'
          when review_reason like '%optic model not found%' then 'no_optic'
          else 'other'
        end as category,
        count(*)::int as n
      from print_jobs
      where status = 'needs_review'
      group by 1
      order by n desc
    `;
    console.log("needs_review categories:");
    for (const c of categories) console.log(`  ${String(c.category).padEnd(16)} ${c.n}`);

    const [{ handles }] = await sql<{ handles: number }[]>`
      select count(distinct li.product_handle)::int as handles
      from print_jobs pj
      join order_line_items li on li.id = pj.order_line_item_id
      where pj.status = 'needs_review' and pj.review_reason like 'No product recipe%'
    `;
    console.log(`\nDistinct products with NO recipe: ${handles}`);

    const topNoRecipe = await sql<{ product_handle: string; jobs: number }[]>`
      select li.product_handle, count(*)::int as jobs
      from print_jobs pj
      join order_line_items li on li.id = pj.order_line_item_id
      where pj.status = 'needs_review' and pj.review_reason like 'No product recipe%'
      group by 1 order by jobs desc limit 20
    `;
    console.log("\nTop no-recipe products (by needs_review jobs):");
    for (const r of topNoRecipe) console.log(`  [${String(r.jobs).padStart(3)}] ${r.product_handle}`);

    console.log("\nSample option shape per top no-recipe product:");
    for (const r of topNoRecipe.slice(0, 8)) {
      const [sample] = await sql<{ variant_title: string | null; properties: unknown }[]>`
        select variant_title, properties
        from order_line_items
        where product_handle = ${r.product_handle}
        limit 1
      `;
      const props = Array.isArray(sample?.properties)
        ? (sample!.properties as { name: string; value: string }[])
            .map((p) => `${p.name}=${p.value}`)
            .join(", ")
        : "";
      console.log(`\n  ${r.product_handle}`);
      console.log(`    variant: ${sample?.variant_title ?? "-"}`);
      console.log(`    props:   ${props || "(none)"}`);
    }

    // Filament gaps (material/color combos we saw but haven't mapped).
    const filamentGaps = await sql<{ review_reason: string; n: number }[]>`
      select review_reason, count(*)::int as n
      from print_jobs
      where status = 'needs_review' and review_reason like '%no filament mapping%'
      group by 1 order by n desc limit 15
    `;
    console.log("\nFilament mapping gaps:");
    for (const g of filamentGaps) console.log(`  [${g.n}] ${g.review_reason}`);
  } finally {
    await sql.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
