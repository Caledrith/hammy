import "dotenv/config";
import { getDb } from "../src/db";
import {
  filamentMap,
  opticAliases,
  partVariants,
  printableFiles,
  productRecipes,
} from "../src/db/schema";
import { normalizeOptic } from "../src/lib/recipes/normalize";
import type { RuleSetInput } from "../src/lib/recipes/types";

/**
 * Seed the catalog with the lens-cover product recipe plus a couple of example
 * optics and a filament map. The rule set mirrors the real option shape observed
 * in live orders (options split across variant title + manufacturer-keyed
 * properties).
 */

const lensCoverRuleSet: RuleSetInput = {
  optionSelectors: {},
  optic: {
    manufacturerKeys: ["Scope Manufacturer", "Scope Cover Manufacturer", "Manufacturer"],
    excludeKeys: [
      "Color",
      "Lens To Cover",
      "Hex Style",
      "Scope Manufacturer",
      "Scope Cover Manufacturer",
    ],
  },
  colorKeys: ["Color"],
  materialKeywords: ["PETG-CF", "PETG", "PLA+", "PLA", "MJF Nylon", "Nylon"],
  rules: [
    {
      label: "Objective cover",
      when: { lens: ["Objective Lens"] },
      printed: [{ partType: "objective_cover" }],
    },
    {
      label: "Ocular cover",
      when: { lens: ["Ocular Lens / Eyepiece", "Ocular Lens", "Eyepiece"] },
      printed: [{ partType: "ocular_cover" }],
    },
    {
      // Tip Grip is a cover attachment style, not a separately-printed part -
      // the grip prints as part of the sized cover. Hardware only.
      label: "Tip Grip attachment",
      when: { style: ["Tip Grip"] },
      hardware: [{ ref: "M3x10 socket head screw" }, { ref: "shock cord" }],
    },
    {
      label: "Rubber Band attachment",
      when: { style: ["Rubber Band"] },
      hardware: [{ ref: "shock cord" }, { ref: "rubber band" }],
    },
    {
      label: "Bikini (both ends)",
      when: { style: ["Bikini (Includes Both Ends)", "Bikini"] },
      printed: [{ partType: "objective_cover" }, { partType: "ocular_cover" }],
      hardware: [{ ref: "shock cord", perUnit: 2 }],
    },
    {
      label: "Killflash add-on (objective)",
      when: { killflash: ["Killflash Add-On (Objective Only)"] },
      printed: [{ partType: "killflash" }],
    },
    {
      label: "Killflash only",
      when: { killflash: ["Killflash ONLY (No Scope Cover)"] },
      printed: [{ partType: "killflash" }],
    },
  ],
};

/**
 * Weapon-mounted flashlight / lens cover. Options come from the storefront's
 * product-options app, which emits numbered property keys (e.g. "Flashlight-4",
 * "Color-5"). The light model lives under a "Flashlight-*" key, so a prefix
 * candidate captures it; color detection already prefix-matches "Color-*".
 * Single printed part - only the captured light model + material/color matter.
 */
const flashlightCoverRuleSet: RuleSetInput = {
  optic: {
    candidates: ["Flashlight", "Flashlight Model", "Light Model"],
    excludeKeys: ["Color", "Version"],
  },
  colorKeys: ["Color"],
  materialKeywords: ["PETG-CF", "PETG", "PLA+", "PLA", "MJF Nylon", "Nylon"],
  rules: [{ label: "default single part", printed: [{ partType: "print" }] }],
};

/**
 * Opt-in per-product filament defaults. Ships EMPTY: an operator adds an entry
 * once they have confirmed a product always prints in a given material/color,
 * which promotes that product's jobs to plate-ready without the engine guessing.
 * Each entry upserts a minimal product_recipes row (default single-part rule +
 * the declared defaults). Do NOT add products that already have a full recipe
 * (e.g. lens-cover-for-scopes) here - it would clobber their rule set.
 */
const productDefaults: {
  key: string;
  name?: string;
  defaultMaterial?: string;
  defaultColor?: string;
}[] = [];

// Minimal rule set carrying only the declared defaults + a single-part rule. The
// engine re-parses stored rule sets, so omitted fields (colorVocab,
// materialKeywords, ...) fall back to the schema defaults - detection still runs,
// and defaults apply only when detection comes up empty.
function defaultsRuleSet(d: { defaultMaterial?: string; defaultColor?: string }) {
  return {
    defaultMaterial: d.defaultMaterial,
    defaultColor: d.defaultColor,
    rules: [{ label: "default single part", printed: [{ partType: "print" }] }],
  };
}

// Physical files: one row per real geometry (deduped by file_path). Objective /
// ocular / killflash files are named by size so multiple optics of the same size
// can share them. Real deployment imports these from the model-file folder tree.
const printableFileSeeds: {
  partType: string;
  filePath: string;
  sizeKey?: string;
  estGrams?: number;
  estMinutes?: number;
}[] = [
  { partType: "objective_cover", filePath: "models/objective/obj-44mm.3mf", sizeKey: "obj-44mm", estGrams: 12, estMinutes: 45 },
  { partType: "objective_cover", filePath: "models/objective/obj-24mm.3mf", sizeKey: "obj-24mm", estGrams: 8, estMinutes: 30 },
  { partType: "ocular_cover", filePath: "models/ocular/ocu-44mm.3mf", sizeKey: "ocu-44mm", estGrams: 10, estMinutes: 40 },
  { partType: "ocular_cover", filePath: "models/ocular/ocu-40mm.3mf", sizeKey: "ocu-40mm", estGrams: 9, estMinutes: 35 },
  { partType: "killflash", filePath: "models/killflash/kf-44mm.3mf", sizeKey: "kf-44mm", estGrams: 14, estMinutes: 50 },
  { partType: "killflash", filePath: "models/killflash/kf-24mm.3mf", sizeKey: "kf-24mm", estGrams: 11, estMinutes: 42 },
  { partType: "tip_grip", filePath: "models/universal/tip_grip.3mf", estGrams: 6, estMinutes: 25 },
];

// Optic (+ optional material) -> file mapping. Note the two 44mm optics both
// point at models/objective/obj-44mm.3mf: the "many optics -> one file" case.
const variantSeeds: {
  partType: string;
  opticModel: string;
  material?: string | null;
  filePath: string;
}[] = [
  { partType: "objective_cover", opticModel: "Continental FFP 2-12x44", filePath: "models/objective/obj-44mm.3mf" },
  { partType: "ocular_cover", opticModel: "Continental FFP 2-12x44", filePath: "models/ocular/ocu-44mm.3mf" },
  { partType: "killflash", opticModel: "Continental FFP 2-12x44", filePath: "models/killflash/kf-44mm.3mf" },
  // Shares the 44mm objective file with the Continental (same size, one STL).
  { partType: "objective_cover", opticModel: "Vortex Viper PST 44mm", filePath: "models/objective/obj-44mm.3mf" },
  { partType: "objective_cover", opticModel: "Tango-MSR 1-6x24mm", filePath: "models/objective/obj-24mm.3mf" },
  { partType: "ocular_cover", opticModel: "Tango-MSR 1-6x24mm", filePath: "models/ocular/ocu-40mm.3mf" },
  { partType: "killflash", opticModel: "Tango-MSR 1-6x24mm", filePath: "models/killflash/kf-24mm.3mf" },
  { partType: "tip_grip", opticModel: "Universal", filePath: "models/universal/tip_grip.3mf" },
];

// Color palette (name -> swatch hex). Includes the colors seen in live orders
// that were previously unmapped: Earth Brown, Light Brown, Forest Green.
const colorPalette: { color: string; hex: string }[] = [
  { color: "Black", hex: "#0a0a0a" },
  { color: "White", hex: "#f5f5f5" },
  { color: "Gray", hex: "#808080" },
  { color: "OD Green", hex: "#556b2f" },
  { color: "Olive Green", hex: "#6b8e23" },
  { color: "Army Green", hex: "#4b5320" },
  { color: "Forest Green", hex: "#228b22" },
  { color: "FDE", hex: "#c9b18c" },
  { color: "Coyote Tan", hex: "#c19a6b" },
  { color: "Earth Brown", hex: "#4b3621" },
  { color: "Light Brown", hex: "#a9744f" },
  { color: "Red", hex: "#b22222" },
  { color: "Blue", hex: "#1f4e8c" },
  { color: "Orange", hex: "#ff6a00" },
  { color: "Purple", hex: "#6a3d9a" },
];

// The only materials the shop stocks in the full color palette.
const paletteMaterials = ["PLA+", "PETG-CF"];

const filaments: { material: string; color: string; hex: string | null }[] = [
  ...paletteMaterials.flatMap((material) =>
    colorPalette.map(({ color, hex }) => ({ material, color, hex }) as const),
  ),
  // MJF Nylon is outsourced (HP Multi Jet Fusion), offered only in black.
  { material: "MJF Nylon", color: "Black", hex: "#0a0a0a" },
  // N/A covers non-printed line items (stickers, patches).
  { material: "N/A", color: "N/A", hex: null },
];

// Printer-side defaults driven by the filament itself: carbon-fiber blends need a
// hardened nozzle + textured plate; high-temp materials prefer an enclosure.
function filamentPrintDefaults(material: string): {
  hardenedNozzle: boolean;
  defaultPlateType: string;
  needsEnclosure: boolean;
} {
  const isCF = /cf/i.test(material);
  const isHighTemp = /^(abs|asa|pc)/i.test(material);
  return {
    hardenedNozzle: isCF,
    defaultPlateType: isCF ? "textured PEI" : "smooth PEI",
    needsEnclosure: isCF || isHighTemp,
  };
}

async function main() {
  const db = getDb();

  // 1. Product recipe (upsert by key).
  await db
    .insert(productRecipes)
    .values({
      key: "lens-cover-for-scopes",
      name: "Scope / Lens Cover for Optics",
      ruleSet: lensCoverRuleSet,
    })
    .onConflictDoUpdate({
      target: productRecipes.key,
      set: { name: "Scope / Lens Cover for Optics", ruleSet: lensCoverRuleSet, updatedAt: new Date() },
    });
  console.log("Seeded recipe: lens-cover-for-scopes");

  // 1a. Flashlight / light-lens cover recipe (upsert by key).
  await db
    .insert(productRecipes)
    .values({
      key: "light-lens-cover-for-flashlights",
      name: "Light / Lens Cover for Weapon-Mounted Flashlights",
      ruleSet: flashlightCoverRuleSet,
    })
    .onConflictDoUpdate({
      target: productRecipes.key,
      set: {
        name: "Light / Lens Cover for Weapon-Mounted Flashlights",
        ruleSet: flashlightCoverRuleSet,
        updatedAt: new Date(),
      },
    });
  console.log("Seeded recipe: light-lens-cover-for-flashlights");

  // 1b. Opt-in per-product filament defaults (ships empty).
  for (const d of productDefaults) {
    const ruleSet = defaultsRuleSet(d);
    await db
      .insert(productRecipes)
      .values({ key: d.key, name: d.name ?? d.key, ruleSet })
      .onConflictDoUpdate({
        target: productRecipes.key,
        set: { name: d.name ?? d.key, ruleSet, updatedAt: new Date() },
      });
  }
  if (productDefaults.length > 0) {
    console.log(`Seeded product defaults: ${productDefaults.length}`);
  }

  // 2a. Printable files (upsert by file_path; the physical geometry you remap).
  for (const f of printableFileSeeds) {
    await db
      .insert(printableFiles)
      .values({
        partType: f.partType,
        filePath: f.filePath,
        sizeKey: f.sizeKey ?? null,
        estGrams: f.estGrams ?? null,
        estMinutes: f.estMinutes ?? null,
      })
      .onConflictDoUpdate({
        target: printableFiles.filePath,
        set: {
          partType: f.partType,
          sizeKey: f.sizeKey ?? null,
          estGrams: f.estGrams ?? null,
          estMinutes: f.estMinutes ?? null,
          updatedAt: new Date(),
        },
      });
  }
  const fileRows = await db
    .select({ id: printableFiles.id, filePath: printableFiles.filePath })
    .from(printableFiles);
  const fileIdByPath = new Map(fileRows.map((r) => [r.filePath, r.id]));
  console.log(`Seeded printable files: ${printableFileSeeds.length}`);

  // 2b. Part variants (optic/size -> file). ON CONFLICT DO NOTHING relies on the
  // partial unique indexes so a reseed is idempotent.
  let variantCount = 0;
  for (const v of variantSeeds) {
    const fileId = fileIdByPath.get(v.filePath);
    if (!fileId) {
      console.warn(`  skip variant ${v.partType}/${v.opticModel}: unknown file ${v.filePath}`);
      continue;
    }
    await db
      .insert(partVariants)
      .values({
        partType: v.partType,
        opticModel: v.opticModel,
        material: v.material ?? null,
        fileId,
      })
      .onConflictDoNothing();
    variantCount += 1;
  }
  console.log(`Seeded part variants: ${variantCount}`);

  // 3. Filament map (upsert by material + color) with printer-side defaults.
  for (const f of filaments) {
    const print = filamentPrintDefaults(f.material);
    await db
      .insert(filamentMap)
      .values({
        materialOption: f.material,
        colorOption: f.color,
        filamentMaterial: f.material,
        colorHex: f.hex,
        slicerProfile: `${f.material} 0.2mm Standard`,
        hardenedNozzle: print.hardenedNozzle,
        defaultPlateType: print.defaultPlateType,
        needsEnclosure: print.needsEnclosure,
      })
      .onConflictDoUpdate({
        target: [filamentMap.materialOption, filamentMap.colorOption],
        set: {
          colorHex: f.hex,
          slicerProfile: `${f.material} 0.2mm Standard`,
          hardenedNozzle: print.hardenedNozzle,
          defaultPlateType: print.defaultPlateType,
          needsEnclosure: print.needsEnclosure,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`Seeded filament map: ${filaments.length} entries`);

  // 4. Example optic alias (demonstrates absorbing naming drift).
  const aliasSource = "Continental FFP 2 12x44mm";
  await db
    .insert(opticAliases)
    .values({
      normalizedSource: normalizeOptic(aliasSource),
      sourceString: aliasSource,
      canonicalOptic: "Continental FFP 2-12x44",
    })
    .onConflictDoNothing({ target: opticAliases.normalizedSource });
  console.log("Seeded 1 example optic alias");

  console.log("\nSeed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nseed failed:\n", err);
    process.exit(1);
  });
