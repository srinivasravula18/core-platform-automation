CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"providers" jsonb,
	"default_provider" text,
	"daily_cost_limit" numeric DEFAULT '50',
	"autonomy_level" text DEFAULT 'review',
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_users" (
	"id" text PRIMARY KEY NOT NULL,
	"website_id" text NOT NULL,
	"label" text,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"role" text DEFAULT 'standard' NOT NULL,
	"use_for_playwright" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"environment" text DEFAULT 'staging' NOT NULL,
	"login_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "website_users" ADD CONSTRAINT "website_users_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE no action ON UPDATE no action;