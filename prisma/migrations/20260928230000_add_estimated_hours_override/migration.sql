-- Lets a person correct a job's estimate on the order page (2026-09-28). Additive.

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "estimatedHoursOverride" DOUBLE PRECISION;
