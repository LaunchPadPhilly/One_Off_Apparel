-- Every Hoops export imports for review, even an incomplete one (2026-09-28).
--
-- * Order ship/due dates become optional: an export with no Deadline still imports,
--   and the order page asks for the ship date before the order can be confirmed.
-- * LineItemType gains OTHER, for a job type the system doesn't model yet (e.g.
--   "Patch Install"). The row keeps the export's name for it (otherJobType) and the
--   reviewer assigns a station (assignedStationId) and hours (manualEstimatedHours).
--
-- Additive only: nothing existing changes value, so the previous release keeps
-- working during the rollout.

-- AlterEnum
ALTER TYPE "LineItemType" ADD VALUE 'OTHER';

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "externalShipDate" DROP NOT NULL,
ALTER COLUMN "internalDueDate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "assignedStationId" TEXT,
ADD COLUMN     "otherJobType" TEXT;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_assignedStationId_fkey" FOREIGN KEY ("assignedStationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;
