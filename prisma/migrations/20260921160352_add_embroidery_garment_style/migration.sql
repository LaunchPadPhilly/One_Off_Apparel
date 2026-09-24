-- CreateEnum
CREATE TYPE "GarmentStyle" AS ENUM ('FLAT', 'CAP');

-- CreateEnum
CREATE TYPE "CapConstruction" AS ENUM ('STRUCTURED', 'UNSTRUCTURED');

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "capConstruction" "CapConstruction",
ADD COLUMN     "garmentStyle" "GarmentStyle";
