-- CreateEnum
CREATE TYPE "MatteSurface" AS ENUM ('FLAT', 'SPECIALTY');

-- CreateEnum
CREATE TYPE "FoldBagGarment" AS ENUM ('SS_TEE', 'OTHER');

-- AlterEnum
ALTER TYPE "FinishingStep" ADD VALUE 'WOVENS';

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "foldBagGarment" "FoldBagGarment",
ADD COLUMN     "matteSurface" "MatteSurface";
