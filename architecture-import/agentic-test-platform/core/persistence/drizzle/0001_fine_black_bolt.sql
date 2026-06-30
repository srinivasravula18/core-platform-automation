CREATE TABLE "connected_repo" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"branch" text,
	"sha" text,
	"framework" text,
	"file_count" integer,
	"has_metadata" boolean,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
