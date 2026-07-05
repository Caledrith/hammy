CREATE TYPE "public"."order_channel" AS ENUM('shopify', 'amazon', 'ebay');--> statement-breakpoint
CREATE TABLE "channel_listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" "order_channel" NOT NULL,
	"external_key" text NOT NULL,
	"product_key" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "orders_shopify_order_id_idx";--> statement-breakpoint
DROP INDEX "order_line_items_shopify_id_idx";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel" "order_channel" DEFAULT 'shopify' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "shopify_order_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "shopify_updated_at" TO "channel_updated_at";--> statement-breakpoint
ALTER TABLE "order_line_items" RENAME COLUMN "shopify_line_item_id" TO "external_id";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_channel_external_id_idx" ON "orders" USING btree ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_items_external_id_idx" ON "order_line_items" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_listings_channel_key_idx" ON "channel_listings" USING btree ("channel","external_key");--> statement-breakpoint
CREATE INDEX "channel_listings_product_key_idx" ON "channel_listings" USING btree ("product_key");
