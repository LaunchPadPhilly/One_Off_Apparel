-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEEDS_REVIEW', 'CONFIRMED', 'SCHEDULED', 'IN_PRODUCTION', 'COMPLETE');

-- CreateEnum
CREATE TYPE "LineItemType" AS ENUM ('DECORATION', 'FINISHING');

-- CreateEnum
CREATE TYPE "PrintLocation" AS ENUM ('FRONT', 'BACK', 'LEFT', 'RIGHT');

-- CreateEnum
CREATE TYPE "DecorationType" AS ENUM ('SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG');

-- CreateEnum
CREATE TYPE "FinishingStep" AS ENUM ('MATTE', 'RELABEL', 'FOLD_BAG', 'HANG_TAG');

-- CreateEnum
CREATE TYPE "LineItemStatus" AS ENUM ('NEEDS_REVIEW', 'BLOCKED', 'IN_PRODUCTION', 'COMPLETE');

-- CreateEnum
CREATE TYPE "WeightClass" AS ENUM ('THIN', 'POLY', 'BULKY');

-- CreateEnum
CREATE TYPE "ScheduleAssignmentStatus" AS ENUM ('PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETE');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "hoopsOrderId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "externalShipDate" DATE NOT NULL,
    "internalDueDate" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "importedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemType" "LineItemType" NOT NULL,
    "design" TEXT NOT NULL,
    "printLocation" "PrintLocation",
    "decorationType" "DecorationType",
    "inkColorCount" INTEGER,
    "screens" INTEGER,
    "stitchCount" INTEGER,
    "finishingStep" "FinishingStep",
    "dependsOn" TEXT,
    "status" "LineItemStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "weightClass" "WeightClass" NOT NULL,
    "apparelColor" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sizeBreakdown" JSONB NOT NULL,
    "estimatedHours" JSONB,
    "reviewConfidence" DOUBLE PRECISION,

    CONSTRAINT "LineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityCalendar" (
    "stationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "availableHrs" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CapacityCalendar_pkey" PRIMARY KEY ("stationId","date")
);

-- CreateTable
CREATE TABLE "ScheduleAssignment" (
    "id" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sequenceOrder" INTEGER NOT NULL,
    "estimatedHours" DOUBLE PRECISION NOT NULL,
    "status" "ScheduleAssignmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Actual" (
    "id" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "actualHours" DOUBLE PRECISION NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Actual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainAuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "diff" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_hoopsOrderId_key" ON "Order"("hoopsOrderId");

-- CreateIndex
CREATE INDEX "LineItem_orderId_idx" ON "LineItem"("orderId");

-- CreateIndex
CREATE INDEX "LineItem_status_idx" ON "LineItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Station_name_key" ON "Station"("name");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_lineItemId_idx" ON "ScheduleAssignment"("lineItemId");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_stationId_idx" ON "ScheduleAssignment"("stationId");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_date_idx" ON "ScheduleAssignment"("date");

-- CreateIndex
CREATE INDEX "Actual_lineItemId_idx" ON "Actual"("lineItemId");

-- CreateIndex
CREATE INDEX "Actual_stationId_idx" ON "Actual"("stationId");

-- CreateIndex
CREATE INDEX "DomainAuditLog_entity_entityId_idx" ON "DomainAuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "DomainAuditLog_at_idx" ON "DomainAuditLog"("at");

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityCalendar" ADD CONSTRAINT "CapacityCalendar_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleAssignment" ADD CONSTRAINT "ScheduleAssignment_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "LineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleAssignment" ADD CONSTRAINT "ScheduleAssignment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Actual" ADD CONSTRAINT "Actual_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "LineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Actual" ADD CONSTRAINT "Actual_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
