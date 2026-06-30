ALTER TABLE "runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "env" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "trigger" SET DEFAULT 'chat';--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "preconditions" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "steps" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "test_cases" ALTER COLUMN "expected" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "object" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "suite_type" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "accuracy" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "suite_types" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;