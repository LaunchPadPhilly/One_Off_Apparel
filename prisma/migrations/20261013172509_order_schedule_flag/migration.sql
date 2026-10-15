-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "scheduleFlagReason" TEXT,
ADD COLUMN     "scheduleFlaggedAt" TIMESTAMP(3);
