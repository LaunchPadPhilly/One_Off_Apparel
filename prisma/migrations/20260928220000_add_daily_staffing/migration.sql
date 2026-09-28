-- Daily staffing (2026-09-28): days a person is out, a person pinned to a station for
-- a day (both set through Claude), and the crew on each scheduled job. Additive only.

-- CreateTable
CREATE TABLE "WorkerUnavailability" (
    "workerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerUnavailability_pkey" PRIMARY KEY ("workerId","date")
);

-- CreateTable
CREATE TABLE "StaffingPin" (
    "workerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffingPin_pkey" PRIMARY KEY ("workerId","date")
);

-- CreateTable
CREATE TABLE "AssignmentCrew" (
    "assignmentId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,

    CONSTRAINT "AssignmentCrew_pkey" PRIMARY KEY ("assignmentId","workerId")
);

-- CreateIndex
CREATE INDEX "WorkerUnavailability_date_idx" ON "WorkerUnavailability"("date");

-- CreateIndex
CREATE INDEX "StaffingPin_date_idx" ON "StaffingPin"("date");

-- CreateIndex
CREATE INDEX "AssignmentCrew_workerId_idx" ON "AssignmentCrew"("workerId");

-- AddForeignKey
ALTER TABLE "WorkerUnavailability" ADD CONSTRAINT "WorkerUnavailability_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingPin" ADD CONSTRAINT "StaffingPin_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingPin" ADD CONSTRAINT "StaffingPin_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentCrew" ADD CONSTRAINT "AssignmentCrew_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ScheduleAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentCrew" ADD CONSTRAINT "AssignmentCrew_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
