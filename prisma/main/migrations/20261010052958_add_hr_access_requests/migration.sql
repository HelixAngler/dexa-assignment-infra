-- CreateEnum
CREATE TYPE "HrAccessRequestType" AS ENUM ('add_hr', 'deactivate_hr');

-- CreateEnum
CREATE TYPE "HrAccessRequestState" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

-- CreateTable
CREATE TABLE "hr_access_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "HrAccessRequestType" NOT NULL,
    "state" "HrAccessRequestState" NOT NULL DEFAULT 'pending',
    "proposed_name" TEXT,
    "proposed_email" CITEXT,
    "proposed_position" TEXT,
    "proposed_phone" TEXT,
    "target_employee_id" UUID,
    "maker_employee_id" UUID NOT NULL,
    "checker_employee_id" UUID,
    "decision_note" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_access_requests_state_created_at_idx" ON "hr_access_requests"("state", "created_at");

-- AddForeignKey
ALTER TABLE "hr_access_requests" ADD CONSTRAINT "hr_access_requests_maker_employee_id_fkey" FOREIGN KEY ("maker_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_access_requests" ADD CONSTRAINT "hr_access_requests_checker_employee_id_fkey" FOREIGN KEY ("checker_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_access_requests" ADD CONSTRAINT "hr_access_requests_target_employee_id_fkey" FOREIGN KEY ("target_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
