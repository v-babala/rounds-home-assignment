CREATE TYPE "public"."comparison_status" AS ENUM('baseline', 'unchanged', 'changed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."poll_status" AS ENUM('running', 'success', 'not_found', 'rate_limited', 'timeout', 'network_error', 'http_error', 'invalid_response', 'incomplete', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."summary_status" AS ENUM('baseline', 'unchanged', 'source_unavailable', 'pending', 'processing', 'retry_wait', 'ready', 'failed', 'budget_exhausted');--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"next_poll_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp (3) with time zone,
	"last_poll_status" "poll_status",
	"last_changed_at" timestamp (3) with time zone,
	"last_valid_version_id" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" varchar(128) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"price" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_daily_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_calls_check" CHECK ("llm_daily_usage"."calls" >= 0 and "llm_daily_usage"."calls" <= 2000)
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" varchar(128) NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp (3) with time zone,
	"status" "poll_status" DEFAULT 'running' NOT NULL,
	"http_status" integer,
	"error_code" text,
	"source_retry_at" timestamp (3) with time zone,
	"version_id" uuid,
	"previous_version_id" uuid,
	"comparison_status" "comparison_status" DEFAULT 'unavailable' NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partial_fields" jsonb,
	"missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary_status" "summary_status" DEFAULT 'source_unavailable' NOT NULL,
	"summary" text,
	"summary_error_code" text,
	"summary_attempts" integer DEFAULT 0 NOT NULL,
	"summary_attempt_id" uuid,
	"summary_started_at" timestamp (3) with time zone,
	"summary_provider" text,
	CONSTRAINT "polls_attempts_check" CHECK ("polls"."summary_attempts" >= 0 and "polls"."summary_attempts" <= 3)
);
--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_last_valid_version_id_listing_versions_id_fk" FOREIGN KEY ("last_valid_version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_version_id_listing_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_previous_version_id_listing_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitors_due_idx" ON "competitors" USING btree ("next_poll_at","id") WHERE "competitors"."active" = true;--> statement-breakpoint
CREATE INDEX "competitors_baseline_idx" ON "competitors" USING btree ("last_valid_version_id");--> statement-breakpoint
CREATE INDEX "versions_created_idx" ON "listing_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "polls_timeline_idx" ON "polls" USING btree ("competitor_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "polls_retention_idx" ON "polls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "polls_source_retry_idx" ON "polls" USING btree ("source_retry_at") WHERE "polls"."status" = 'rate_limited';--> statement-breakpoint
CREATE INDEX "polls_pending_summary_idx" ON "polls" USING btree ("id") WHERE "polls"."summary_status" in ('pending', 'processing', 'retry_wait');--> statement-breakpoint
CREATE UNIQUE INDEX "polls_one_running_idx" ON "polls" USING btree ("competitor_id") WHERE "polls"."status" = 'running';--> statement-breakpoint
CREATE INDEX "polls_version_idx" ON "polls" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "polls_previous_version_idx" ON "polls" USING btree ("previous_version_id");