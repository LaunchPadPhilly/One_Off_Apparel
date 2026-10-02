-- CreateEnum
CREATE TYPE "ArtworkApprovalStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING_APPROVAL', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "BlankOrderingStatus" AS ENUM ('NOT_ORDERED', 'ORDERED', 'ISSUE', 'RECEIVED');

-- CreateEnum
CREATE TYPE "CustomerApprovalStatus" AS ENUM ('NOT_SENT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED');

-- AlterTable: Order — add pre-production approval gates at order level
ALTER TABLE "Order" ADD COLUMN "blankOrderingStatus" "BlankOrderingStatus" NOT NULL DEFAULT 'NOT_ORDERED';
ALTER TABLE "Order" ADD COLUMN "customerApprovalStatus" "CustomerApprovalStatus" NOT NULL DEFAULT 'NOT_SENT';

-- AlterTable: LineItem — add artwork approval gate (nullable; null for finishing rows)
ALTER TABLE "LineItem" ADD COLUMN "artworkApprovalStatus" "ArtworkApprovalStatus";
