-- Data-only migration (client decision 2026-09-28): only matte and
-- fold & bag wait on other jobs. See src/lib/server/engine/finishingDependencies.ts.
--
-- 1. Relabel, hang tags and wovens wait on nothing: clear their dependency, and
--    unlock any that are still BLOCKED (same unlock status check_completion uses).
UPDATE "LineItem"
SET "dependsOn" = NULL,
    "status" = CASE WHEN "status" = 'BLOCKED' THEN 'NEEDS_REVIEW'::"LineItemStatus" ELSE "status" END
WHERE "itemType" = 'FINISHING'
  AND "finishingStep" IN ('RELABEL', 'HANG_TAG', 'WOVENS');

-- 2. Fold & bag waits on every other job on the order.
UPDATE "LineItem"
SET "dependsOn" = 'all_siblings'
WHERE "itemType" = 'FINISHING'
  AND "finishingStep" = 'FOLD_BAG'
  AND "dependsOn" IS DISTINCT FROM 'all_siblings';

-- Matte keeps whatever it already waits on (its print, or everything).
