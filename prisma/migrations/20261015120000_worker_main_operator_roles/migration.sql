-- Worker-level main/operator + per-assignment crew role (2026-10-15).
--
-- Replaces the per-certification isMain flag with two worker-level flags so
-- "Main" is a general property of a person (they can run any press they're
-- certified on as main) rather than per-press. Adds "Operator" as a middle
-- tier: can run a press as a fallback lead, but a main is preferred.
--
-- Also replaces the per-assignment AssignmentCrew.isMain boolean with a three-
-- valued CrewRole enum so the planner (and a human-driven role switch on the
-- draft board) can mark a press crew member as MAIN, OPERATOR or CATCH.

-- CreateEnum
CREATE TYPE "CrewRole" AS ENUM ('MAIN', 'OPERATOR', 'CATCH');

-- AlterTable: worker-level flags
ALTER TABLE "Worker" ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Worker" ADD COLUMN "isOperator" BOOLEAN NOT NULL DEFAULT false;

-- Carry forward: anyone who had any press certification ticked "Main" becomes
-- Worker.isMain = true. The per-cert flag is dropped below.
UPDATE "Worker"
SET "isMain" = true
WHERE id IN (SELECT DISTINCT "workerId" FROM "WorkerCertification" WHERE "isMain" = true);

-- AlterTable: drop per-cert isMain
ALTER TABLE "WorkerCertification" DROP COLUMN "isMain";

-- AlterTable: add role, backfill from legacy isMain, drop isMain
ALTER TABLE "AssignmentCrew" ADD COLUMN "role" "CrewRole" NOT NULL DEFAULT 'CATCH';
UPDATE "AssignmentCrew" SET "role" = 'MAIN' WHERE "isMain" = true;
ALTER TABLE "AssignmentCrew" DROP COLUMN "isMain";
