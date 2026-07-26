CREATE TYPE "public"."locale" AS ENUM('ml', 'en');--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "locale" "locale" DEFAULT 'ml' NOT NULL;