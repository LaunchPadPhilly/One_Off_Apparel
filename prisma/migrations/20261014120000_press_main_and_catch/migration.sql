-- Press main / catch (2026-10-14): which certified people may run a screen-print press
-- as its main printer, and which crew member was the main on a planned job.
-- Additive only. Existing certifications default to catch — an admin ticks "Main" for
-- the press operators in Settings → People.

-- AlterTable
ALTER TABLE "WorkerCertification" ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AssignmentCrew" ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT false;
