-- Data-only fix (2026-09-28): a MATTE row the import couldn't link to one design used
-- to wait on "all_siblings" — everything on the order, including fold & bag, which
-- itself waits on everything. The two waited on each other forever: neither could be
-- scheduled or unlocked. Such a matte now waits on every design ("all_decorations").

UPDATE "LineItem"
SET "dependsOn" = 'all_decorations'
WHERE "itemType" = 'FINISHING'
  AND "finishingStep" = 'MATTE'
  AND "dependsOn" = 'all_siblings';

-- Unlock any such matte that's still blocked although every design on its order is
-- already complete (the same unlock check_completion would have done).
UPDATE "LineItem" AS matte
SET "status" = 'NEEDS_REVIEW'::"LineItemStatus"
WHERE matte."itemType" = 'FINISHING'
  AND matte."finishingStep" = 'MATTE'
  AND matte."dependsOn" = 'all_decorations'
  AND matte."status" = 'BLOCKED'
  AND NOT EXISTS (
    SELECT 1 FROM "LineItem" AS design
    WHERE design."orderId" = matte."orderId"
      AND design."itemType" = 'DECORATION'
      AND design."status" <> 'COMPLETE'
  );
