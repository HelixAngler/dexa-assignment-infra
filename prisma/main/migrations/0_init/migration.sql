-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('active', 'deactivated');

-- CreateEnum
CREATE TYPE "EmployeeRole" AS ENUM ('employee', 'hrd');

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "position" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "photo_object_key" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'active',
    "role" "EmployeeRole" NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "auth_provider" TEXT NOT NULL DEFAULT 'local',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "clock_in_at" TIMESTAMPTZ NOT NULL,
    "clock_out_at" TIMESTAMPTZ,
    "clock_in_key" UUID NOT NULL,
    "clock_out_key" UUID,
    "closed_by_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_change_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_role" "EmployeeRole" NOT NULL,
    "changed_fields" TEXT[],
    "before_values" JSONB,
    "after_values" JSONB,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "profile_change_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_clock_in_key_key" ON "attendance_sessions"("clock_in_key");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_clock_out_key_key" ON "attendance_sessions"("clock_out_key");

-- CreateIndex
CREATE INDEX "attendance_sessions_work_date_idx" ON "attendance_sessions"("work_date");

-- CreateIndex
CREATE INDEX "attendance_sessions_employee_id_work_date_idx" ON "attendance_sessions"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "profile_change_events_occurred_at_idx" ON "profile_change_events"("occurred_at");

-- CreateIndex
-- Partial indexes: a row counts as "one open session" only while clock_out_at is
-- NULL, and an outbox row counts as "pending" only while published_at is NULL.
-- Both predicates are database invariants enforced here because the schema
-- language cannot express conditional indexes.
CREATE UNIQUE INDEX "attendance_sessions_one_open_key" ON "attendance_sessions"("employee_id") WHERE "clock_out_at" IS NULL;

-- CreateIndex
CREATE INDEX "profile_change_events_unpublished_idx" ON "profile_change_events"("published_at") WHERE "published_at" IS NULL;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_change_events" ADD CONSTRAINT "profile_change_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
