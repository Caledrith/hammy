CREATE TYPE "public"."plate_status" AS ENUM('draft', 'claimed', 'sliced', 'failed', 'printing', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "plate_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"plate_id" integer NOT NULL,
	"print_job_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plates" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "plate_status" DEFAULT 'draft' NOT NULL,
	"group_key" text NOT NULL,
	"material_option" text,
	"color_option" text,
	"color_hex" text,
	"nozzle" real DEFAULT 0.4 NOT NULL,
	"plate_type" text,
	"slicer_profile" text,
	"target_printer_model" text,
	"claimed_at" timestamp with time zone,
	"artifact_filename" text,
	"est_grams" integer,
	"est_minutes" integer,
	"object_count" integer,
	"error_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"serial" text,
	"ip" text,
	"access_code" text,
	"nozzle_diameter" real DEFAULT 0.4 NOT NULL,
	"has_enclosure" boolean DEFAULT false NOT NULL,
	"supports_hardened" boolean DEFAULT false NOT NULL,
	"ams_snapshot" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "part_variants_optic_material_idx";--> statement-breakpoint
DROP INDEX "part_variants_optic_nomaterial_idx";--> statement-breakpoint
ALTER TABLE "plate_jobs" ADD CONSTRAINT "plate_jobs_plate_id_plates_id_fk" FOREIGN KEY ("plate_id") REFERENCES "public"."plates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plate_jobs" ADD CONSTRAINT "plate_jobs_print_job_id_print_jobs_id_fk" FOREIGN KEY ("print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plate_jobs_plate_idx" ON "plate_jobs" USING btree ("plate_id");--> statement-breakpoint
CREATE INDEX "plate_jobs_job_idx" ON "plate_jobs" USING btree ("print_job_id");--> statement-breakpoint
CREATE INDEX "plates_status_idx" ON "plates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plates_group_key_idx" ON "plates" USING btree ("group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_name_idx" ON "printers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "part_variants_optic_material_idx" ON "part_variants" USING btree ("part_type","optic_model","material") WHERE "part_variants"."material" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "part_variants_optic_nomaterial_idx" ON "part_variants" USING btree ("part_type","optic_model") WHERE "part_variants"."material" is null;