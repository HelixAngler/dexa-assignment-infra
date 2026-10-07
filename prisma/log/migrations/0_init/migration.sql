-- CreateEnum
CREATE TYPE "EmployeeRole" AS ENUM ('employee', 'hrd');

-- CreateTable
CREATE TABLE "profile_change_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "employee_email" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_role" "EmployeeRole" NOT NULL,
    "changed_fields" TEXT[],
    "before_values" JSONB,
    "after_values" JSONB,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_change_log_event_id_key" ON "profile_change_log"("event_id");
