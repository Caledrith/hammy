CREATE TYPE "public"."bom_kind" AS ENUM('printed', 'hardware');--> statement-breakpoint
CREATE TYPE "public"."line_item_resolution_status" AS ENUM('pending', 'resolved', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('pending', 'ready', 'needs_review', 'assigned', 'printing', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "bom_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_line_item_id" integer NOT NULL,
	"kind" "bom_kind" NOT NULL,
	"ref" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filament_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"material_option" text NOT NULL,
	"color_option" text NOT NULL,
	"filament_material" text NOT NULL,
	"color_hex" text,
	"slicer_profile" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_type" text NOT NULL,
	"optic_model" text NOT NULL,
	"material" text,
	"file_path" text NOT NULL,
	"est_grams" integer,
	"est_minutes" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optic_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"normalized_source" text NOT NULL,
	"source_string" text NOT NULL,
	"canonical_optic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"shopify_line_item_id" text NOT NULL,
	"title" text,
	"sku" text,
	"product_handle" text,
	"variant_id" text,
	"variant_title" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"properties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution_status" "line_item_resolution_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"shopify_order_id" text NOT NULL,
	"name" text,
	"email" text,
	"customer_name" text,
	"financial_status" text,
	"fulfillment_status" text,
	"currency" text,
	"cancelled_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone,
	"shipping" jsonb,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_line_item_id" integer NOT NULL,
	"part_type" text NOT NULL,
	"model_file_id" integer,
	"optic_model" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"material_option" text,
	"color_option" text,
	"filament_material" text,
	"color_hex" text,
	"slicer_profile" text,
	"status" "print_job_status" DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"shopify_product_id" text,
	"name" text,
	"rule_set" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp with time zone,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_order_line_item_id_order_line_items_id_fk" FOREIGN KEY ("order_line_item_id") REFERENCES "public"."order_line_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_line_item_id_order_line_items_id_fk" FOREIGN KEY ("order_line_item_id") REFERENCES "public"."order_line_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_model_file_id_model_files_id_fk" FOREIGN KEY ("model_file_id") REFERENCES "public"."model_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_components_line_item_idx" ON "bom_components" USING btree ("order_line_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "filament_map_material_color_idx" ON "filament_map" USING btree ("material_option","color_option");--> statement-breakpoint
CREATE INDEX "model_files_part_optic_idx" ON "model_files" USING btree ("part_type","optic_model");--> statement-breakpoint
CREATE UNIQUE INDEX "optic_aliases_normalized_idx" ON "optic_aliases" USING btree ("normalized_source");--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_items_shopify_id_idx" ON "order_line_items" USING btree ("shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "order_line_items_order_id_idx" ON "order_line_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_line_items_resolution_idx" ON "order_line_items" USING btree ("resolution_status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shopify_order_id_idx" ON "orders" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX "print_jobs_line_item_idx" ON "print_jobs" USING btree ("order_line_item_id");--> statement-breakpoint
CREATE INDEX "print_jobs_status_idx" ON "print_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_recipes_key_idx" ON "product_recipes" USING btree ("key");