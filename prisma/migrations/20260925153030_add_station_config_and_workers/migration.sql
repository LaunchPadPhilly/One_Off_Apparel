-- Admin-managed stations + worker roster (config settings, 2026-09-25).
--
-- Station gains label/kind/autoSchedule/sortOrder/archivedAt/createdAt. label and
-- kind are added nullable, backfilled, then made NOT NULL so the 9 existing rows
-- survive. Every station name the app knew before this change is seeded here
-- (INSERT ... ON CONFLICT DO NOTHING), which keeps the previous release's
-- upsert-on-read code (still running during a rollout) on its no-op update path:
-- it never has to insert a row without label/kind.

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "autoSchedule" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Seed the previously hard-coded stations if this database never created them.
INSERT INTO "Station" ("id", "name", "type")
SELECT gen_random_uuid()::text, known.name, 'production'
FROM (VALUES ('screen_print_auto'), ('embroidery'), ('dtf'), ('dtg'), ('matte_finish'),
             ('fold_bag'), ('hang_tags'), ('printed_relabel'), ('wovens')) AS known(name)
ON CONFLICT ("name") DO NOTHING;

-- Backfill: a pre-existing station's name WAS its kind.
UPDATE "Station" SET
  "kind" = "name",
  "label" = CASE "name"
    WHEN 'screen_print_auto' THEN 'Screen Print Auto 1'
    WHEN 'embroidery' THEN 'Embroidery'
    WHEN 'dtf' THEN 'DTF'
    WHEN 'dtg' THEN 'DTG'
    WHEN 'matte_finish' THEN 'Matte Finish'
    WHEN 'fold_bag' THEN 'Fold & Bag'
    WHEN 'hang_tags' THEN 'Hang Tags'
    WHEN 'printed_relabel' THEN 'Printed Relabel'
    WHEN 'wovens' THEN 'Wovens'
    ELSE initcap(replace("name", '_', ' '))
  END,
  "sortOrder" = CASE "name"
    WHEN 'screen_print_auto' THEN 10
    WHEN 'embroidery' THEN 20
    WHEN 'dtf' THEN 30
    WHEN 'dtg' THEN 40
    WHEN 'printed_relabel' THEN 50
    WHEN 'matte_finish' THEN 60
    WHEN 'hang_tags' THEN 70
    WHEN 'wovens' THEN 80
    WHEN 'fold_bag' THEN 90
    ELSE 100
  END;

ALTER TABLE "Station" ALTER COLUMN "kind" SET NOT NULL,
ALTER COLUMN "label" SET NOT NULL;

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCertification" (
    "workerId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerCertification_pkey" PRIMARY KEY ("workerId","stationId")
);

-- CreateIndex
CREATE INDEX "WorkerCertification_stationId_idx" ON "WorkerCertification"("stationId");

-- CreateIndex
CREATE INDEX "Station_kind_idx" ON "Station"("kind");

-- AddForeignKey
ALTER TABLE "WorkerCertification" ADD CONSTRAINT "WorkerCertification_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCertification" ADD CONSTRAINT "WorkerCertification_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;
