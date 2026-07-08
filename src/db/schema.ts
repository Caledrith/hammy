import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const lineItemResolutionStatus = pgEnum("line_item_resolution_status", [
  "pending",
  "resolved",
  "needs_review",
]);

export const printJobStatus = pgEnum("print_job_status", [
  "pending",
  "ready",
  "needs_review",
  "assigned",
  "printing",
  "done",
  "failed",
  "cancelled",
]);

export const bomKind = pgEnum("bom_kind", ["printed", "hardware"]);

// Sales channels an order can originate from.
export const orderChannel = pgEnum("order_channel", ["shopify", "amazon", "ebay"]);

// Lifecycle of a composed plate as it moves through the slicer worker.
//   draft     - composed on the server, waiting for a worker to claim it
//   claimed   - a worker has picked it up and is slicing (lease via claimed_at)
//   sliced    - worker exported a .gcode.3mf and reported real estimates
//   failed    - arrange/slice failed; member jobs are dropped back to ready
//   printing  - dispatched to a printer (later phase)
//   done      - printed
//   cancelled - abandoned by an operator
export const plateStatus = pgEnum("plate_status", [
  "draft",
  "claimed",
  "sliced",
  "failed",
  "printing",
  "done",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Line-item property shape (Shopify customAttributes)
// ---------------------------------------------------------------------------

export type LineItemProperty = { name: string; value: string };

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    channel: orderChannel("channel").notNull().default("shopify"),
    // Channel-native order id (Shopify GID, Amazon AmazonOrderId, eBay orderId).
    externalId: text("external_id").notNull(),
    name: text("name"),
    email: text("email"),
    customerName: text("customer_name"),
    financialStatus: text("financial_status"),
    fulfillmentStatus: text("fulfillment_status"),
    currency: text("currency"),
    // Money stored as decimal strings (channel-native) to avoid float drift.
    totalPrice: text("total_price"),
    totalDiscounts: text("total_discounts"),
    discountCodes: jsonb("discount_codes").$type<string[]>().notNull().default([]),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // Channel-native "last updated" timestamp used for incremental sync cursors.
    channelUpdatedAt: timestamp("channel_updated_at", { withTimezone: true }),
    shipping: jsonb("shipping"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("orders_channel_external_id_idx").on(t.channel, t.externalId)],
);

// ---------------------------------------------------------------------------
// Order line items
// ---------------------------------------------------------------------------

export const orderLineItems = pgTable(
  "order_line_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Channel-native line-item id.
    externalId: text("external_id").notNull(),
    title: text("title"),
    sku: text("sku"),
    productHandle: text("product_handle"),
    variantId: text("variant_id"),
    variantTitle: text("variant_title"),
    quantity: integer("quantity").notNull().default(1),
    // Per-unit price (decimal string) at time of purchase.
    unitPrice: text("unit_price"),
    properties: jsonb("properties").$type<LineItemProperty[]>().notNull().default([]),
    resolutionStatus: lineItemResolutionStatus("resolution_status")
      .notNull()
      .default("pending"),
    // Internal product identity resolved at ingest time (channel_listings
    // product_key, falling back to handle then SKU). Used to group review work.
    productKey: text("product_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("order_line_items_external_id_idx").on(t.externalId),
    index("order_line_items_order_id_idx").on(t.orderId),
    index("order_line_items_resolution_idx").on(t.resolutionStatus),
    index("order_line_items_product_key_idx").on(t.productKey),
  ],
);

// ---------------------------------------------------------------------------
// Catalog: product recipes (options -> BOM rules)
// ---------------------------------------------------------------------------

export const productRecipes = pgTable(
  "product_recipes",
  {
    id: serial("id").primaryKey(),
    // Match key: product handle or a base SKU.
    key: text("key").notNull(),
    shopifyProductId: text("shopify_product_id"),
    name: text("name"),
    ruleSet: jsonb("rule_set").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("product_recipes_key_idx").on(t.key)],
);

// ---------------------------------------------------------------------------
// Catalog: channel listings (cross-channel product identity)
//   (channel, external_key) -> internal product_key (matches product_recipes.key)
// e.g. shopify handle / Amazon ASIN / eBay SKU all map to one internal product.
// ---------------------------------------------------------------------------

export const channelListings = pgTable(
  "channel_listings",
  {
    id: serial("id").primaryKey(),
    channel: orderChannel("channel").notNull(),
    // Channel-native product key: Shopify handle, Amazon ASIN, eBay SKU, etc.
    externalKey: text("external_key").notNull(),
    // Internal product identity; recipes are keyed on this (product_recipes.key).
    productKey: text("product_key").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("channel_listings_channel_key_idx").on(t.channel, t.externalKey),
    index("channel_listings_product_key_idx").on(t.productKey),
  ],
);

// ---------------------------------------------------------------------------
// Catalog: printable files (one row per physical STL/3MF geometry). This is the
// thing you remap: many optics/sizes can point at one file, and per-file print
// specs (grams, nozzle, plate) live here once instead of being duplicated.
// ---------------------------------------------------------------------------

export const printableFiles = pgTable(
  "printable_files",
  {
    id: serial("id").primaryKey(),
    partType: text("part_type").notNull(),
    filePath: text("file_path").notNull(),
    // Optional size grouping (e.g. "obj-44mm") so covers that share dimensions
    // can be queried together. Each file covers one part (objective/ocular are
    // separate part types).
    sizeKey: text("size_key"),
    estGrams: integer("est_grams"),
    estMinutes: integer("est_minutes"),
    nozzleDiameter: real("nozzle_diameter").notNull().default(0.4),
    layerHeight: real("layer_height"),
    plateType: text("plate_type"),
    orientationNotes: text("orientation_notes"),
    needsEnclosure: boolean("needs_enclosure").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("printable_files_path_idx").on(t.filePath),
    index("printable_files_part_idx").on(t.partType),
  ],
);

// ---------------------------------------------------------------------------
// Catalog: part variants - the (part_type, optic_model, material) -> file
// mapping. Many optics/sizes can resolve to one printable file (scope covers by
// size, shared killflashes). Remap = repoint file_id (or swap the file's path).
// ---------------------------------------------------------------------------

export const partVariants = pgTable(
  "part_variants",
  {
    id: serial("id").primaryKey(),
    partType: text("part_type").notNull(),
    // Canonical optic model (post-alias). "Universal" for non-optic parts.
    opticModel: text("optic_model").notNull(),
    // NULL material means "applies to any material" (geometry is material-agnostic).
    material: text("material"),
    fileId: integer("file_id")
      .notNull()
      .references(() => printableFiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // NULL-safe uniqueness on (part_type, optic_model, material): a pair of
    // partial unique indexes so a material-agnostic row and material-specific
    // rows can't silently duplicate (Postgres treats NULLs as distinct).
    uniqueIndex("part_variants_optic_material_idx")
      .on(t.partType, t.opticModel, t.material)
      .where(sql`${t.material} is not null`),
    uniqueIndex("part_variants_optic_nomaterial_idx")
      .on(t.partType, t.opticModel)
      .where(sql`${t.material} is null`),
    index("part_variants_file_idx").on(t.fileId),
  ],
);

// ---------------------------------------------------------------------------
// Catalog: optic aliases (source string -> canonical optic model)
// ---------------------------------------------------------------------------

export const opticAliases = pgTable(
  "optic_aliases",
  {
    id: serial("id").primaryKey(),
    // Normalized source string (see normalizeOptic).
    normalizedSource: text("normalized_source").notNull(),
    sourceString: text("source_string").notNull(),
    canonicalOptic: text("canonical_optic").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("optic_aliases_normalized_idx").on(t.normalizedSource)],
);

// ---------------------------------------------------------------------------
// Catalog: filament map ((material, color) -> filament + slicer profile)
// ---------------------------------------------------------------------------

export const filamentMap = pgTable(
  "filament_map",
  {
    id: serial("id").primaryKey(),
    materialOption: text("material_option").notNull(),
    colorOption: text("color_option").notNull(),
    filamentMaterial: text("filament_material").notNull(),
    colorHex: text("color_hex"),
    slicerProfile: text("slicer_profile"),
    // Printer-side constraints driven by the filament itself.
    hardenedNozzle: boolean("hardened_nozzle").notNull().default(false),
    defaultPlateType: text("default_plate_type"),
    needsEnclosure: boolean("needs_enclosure").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("filament_map_material_color_idx").on(t.materialOption, t.colorOption),
  ],
);

// ---------------------------------------------------------------------------
// Print jobs
// ---------------------------------------------------------------------------

export const printJobs = pgTable(
  "print_jobs",
  {
    id: serial("id").primaryKey(),
    orderLineItemId: integer("order_line_item_id")
      .notNull()
      .references(() => orderLineItems.id, { onDelete: "cascade" }),
    partType: text("part_type").notNull(),
    printableFileId: integer("printable_file_id").references(() => printableFiles.id, {
      onDelete: "set null",
    }),
    opticModel: text("optic_model"),
    quantity: integer("quantity").notNull().default(1),
    materialOption: text("material_option"),
    colorOption: text("color_option"),
    filamentMaterial: text("filament_material"),
    colorHex: text("color_hex"),
    slicerProfile: text("slicer_profile"),
    status: printJobStatus("status").notNull().default("pending"),
    reviewReason: text("review_reason"),
    // Structured review classification: 'no_bom_rule' | 'filament_unknown'.
    // NULL when the job is not in review. Free text (not an enum) so new kinds
    // don't require a migration.
    reviewKind: text("review_kind"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("print_jobs_line_item_idx").on(t.orderLineItemId),
    index("print_jobs_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Bill-of-materials components (printed + hardware) per line item
// ---------------------------------------------------------------------------

export const bomComponents = pgTable(
  "bom_components",
  {
    id: serial("id").primaryKey(),
    orderLineItemId: integer("order_line_item_id")
      .notNull()
      .references(() => orderLineItems.id, { onDelete: "cascade" }),
    kind: bomKind("kind").notNull(),
    ref: text("ref").notNull(),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("bom_components_line_item_idx").on(t.orderLineItemId)],
);

// ---------------------------------------------------------------------------
// Sync state (poller cursor)
// ---------------------------------------------------------------------------

export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Printers (fleet). Seeded manually for now; capability columns let the
// composer pick a target model that can actually run a plate's filament
// (nozzle size, enclosure, hardened nozzle). amsSnapshot is filled by the
// worker's telemetry loop in a later phase.
// ---------------------------------------------------------------------------

export const printers = pgTable(
  "printers",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    // Free text (P1S / P2S / H2 / ...) rather than an enum so new models don't
    // require a migration, matching how materials / plate types are stored.
    model: text("model").notNull(),
    serial: text("serial"),
    ip: text("ip"),
    accessCode: text("access_code"),
    nozzleDiameter: real("nozzle_diameter").notNull().default(0.4),
    hasEnclosure: boolean("has_enclosure").notNull().default(false),
    supportsHardened: boolean("supports_hardened").notNull().default(false),
    amsSnapshot: jsonb("ams_snapshot"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("printers_name_idx").on(t.name)],
);

// ---------------------------------------------------------------------------
// Plates: a composed, sliceable unit. One plate = one printer setup (single
// filament, one nozzle + plate type) with a set of part instances arranged on
// it. group_key mirrors the /plates grouping (material||color||nozzle||plate).
// ---------------------------------------------------------------------------

export const plates = pgTable(
  "plates",
  {
    id: serial("id").primaryKey(),
    status: plateStatus("status").notNull().default("draft"),
    groupKey: text("group_key").notNull(),
    materialOption: text("material_option"),
    colorOption: text("color_option"),
    colorHex: text("color_hex"),
    nozzle: real("nozzle").notNull().default(0.4),
    plateType: text("plate_type"),
    slicerProfile: text("slicer_profile"),
    targetPrinterModel: text("target_printer_model"),
    // Set while status = claimed; a stale lease lets the server reclaim a plate
    // whose worker died mid-slice.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Filename of the .gcode.3mf the worker exported (kept on the shop PC).
    artifactFilename: text("artifact_filename"),
    // Real numbers parsed from the slicer's slice_info after a successful slice.
    estGrams: integer("est_grams"),
    estMinutes: integer("est_minutes"),
    objectCount: integer("object_count"),
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("plates_status_idx").on(t.status),
    index("plates_group_key_idx").on(t.groupKey),
  ],
);

// ---------------------------------------------------------------------------
// Plate <-> print job mapping. quantity is the number of units of that job
// physically placed on this plate (a job can split across plates when it
// overflows one bed).
// ---------------------------------------------------------------------------

export const plateJobs = pgTable(
  "plate_jobs",
  {
    id: serial("id").primaryKey(),
    plateId: integer("plate_id")
      .notNull()
      .references(() => plates.id, { onDelete: "cascade" }),
    printJobId: integer("print_job_id")
      .notNull()
      .references(() => printJobs.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("plate_jobs_plate_idx").on(t.plateId),
    index("plate_jobs_job_idx").on(t.printJobId),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ReviewKind = "no_bom_rule" | "filament_unknown";

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLineItem = typeof orderLineItems.$inferSelect;
export type NewOrderLineItem = typeof orderLineItems.$inferInsert;
export type ProductRecipe = typeof productRecipes.$inferSelect;
export type ChannelListing = typeof channelListings.$inferSelect;
export type NewChannelListing = typeof channelListings.$inferInsert;
export type PrintableFile = typeof printableFiles.$inferSelect;
export type NewPrintableFile = typeof printableFiles.$inferInsert;
export type PartVariant = typeof partVariants.$inferSelect;
export type NewPartVariant = typeof partVariants.$inferInsert;
export type OpticAlias = typeof opticAliases.$inferSelect;
export type FilamentMapping = typeof filamentMap.$inferSelect;
export type PrintJob = typeof printJobs.$inferSelect;
export type NewPrintJob = typeof printJobs.$inferInsert;
export type BomComponent = typeof bomComponents.$inferSelect;
export type NewBomComponent = typeof bomComponents.$inferInsert;
export type Printer = typeof printers.$inferSelect;
export type NewPrinter = typeof printers.$inferInsert;
export type Plate = typeof plates.$inferSelect;
export type NewPlate = typeof plates.$inferInsert;
export type PlateJob = typeof plateJobs.$inferSelect;
export type NewPlateJob = typeof plateJobs.$inferInsert;
