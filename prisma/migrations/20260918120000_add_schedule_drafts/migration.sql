-- CreateEnum
CREATE TYPE "ScheduleStrategy" AS ENUM ('BATCH_OPTIMIZE', 'STRICT_DUE_DATE');

-- CreateEnum
CREATE TYPE "ScheduleDraftStatus" AS ENUM ('DRAFT', 'PROPOSED', 'APPROVED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ScheduleDraft" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startDate" DATE NOT NULL,
    "weeks" INTEGER NOT NULL,
    "strategy" "ScheduleStrategy" NOT NULL DEFAULT 'BATCH_OPTIMIZE',
    "status" "ScheduleDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleDraft_status_idx" ON "ScheduleDraft"("status");

-- CreateIndex
CREATE INDEX "ScheduleDraft_startDate_idx" ON "ScheduleDraft"("startDate");
