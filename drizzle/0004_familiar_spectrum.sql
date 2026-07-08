ALTER TABLE "order_line_items" ADD COLUMN "product_key" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "review_kind" text;--> statement-breakpoint
CREATE INDEX "order_line_items_product_key_idx" ON "order_line_items" USING btree ("product_key");