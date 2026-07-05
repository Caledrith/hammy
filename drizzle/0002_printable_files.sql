CREATE TABLE "printable_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_type" text NOT NULL,
	"file_path" text NOT NULL,
	"size_key" text,
	"est_grams" integer,
	"est_minutes" integer,
	"nozzle_diameter" real DEFAULT 0.4 NOT NULL,
	"layer_height" real,
	"plate_type" text,
	"orientation_notes" text,
	"needs_enclosure" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"part_type" text NOT NULL,
	"optic_model" text NOT NULL,
	"material" text,
	"file_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "part_variants" ADD CONSTRAINT "part_variants_file_id_printable_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."printable_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "print_jobs" SET "model_file_id" = NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" DROP CONSTRAINT "print_jobs_model_file_id_model_files_id_fk";--> statement-breakpoint
ALTER TABLE "print_jobs" RENAME COLUMN "model_file_id" TO "printable_file_id";--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printable_file_id_printable_files_id_fk" FOREIGN KEY ("printable_file_id") REFERENCES "public"."printable_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filament_map" ADD COLUMN "hardened_nozzle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "filament_map" ADD COLUMN "default_plate_type" text;--> statement-breakpoint
ALTER TABLE "filament_map" ADD COLUMN "needs_enclosure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP TABLE "model_files";--> statement-breakpoint
CREATE UNIQUE INDEX "printable_files_path_idx" ON "printable_files" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "printable_files_part_idx" ON "printable_files" USING btree ("part_type");--> statement-breakpoint
CREATE UNIQUE INDEX "part_variants_optic_material_idx" ON "part_variants" USING btree ("part_type","optic_model","material") WHERE "material" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "part_variants_optic_nomaterial_idx" ON "part_variants" USING btree ("part_type","optic_model") WHERE "material" IS NULL;--> statement-breakpoint
CREATE INDEX "part_variants_file_idx" ON "part_variants" USING btree ("file_id");
