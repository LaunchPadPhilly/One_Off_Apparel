-- One deadline + firmness flag replaces the earlier two-date model.
-- Before: Order had externalShipDate (customer promise) and internalDueDate (always
--         externalShipDate − 14 days, per the 2026-09-22 decision).
-- After:  Order has one `deadline` DATE and `deadlineIsTight` BOOLEAN — tight means a
--         firm customer commitment, loose means an internal target the shop is aiming
--         at but hasn't promised. Placement is identical either way; only the meaning
--         of "at risk" softens. The fixed 14-day lead-time rule is gone with this
--         migration; `src/lib/internalDueDate.ts` is deleted in the same commit.

ALTER TABLE "Order" ADD COLUMN "deadline" DATE;
ALTER TABLE "Order" ADD COLUMN "deadlineIsTight" BOOLEAN NOT NULL DEFAULT true;

-- Preserve every existing order's operative date. externalShipDate was the customer
-- ship date, so if present, it is the deadline as-is. If only internalDueDate exists
-- (an old row that was hand-set without a ship date), reconstruct the ship date it was
-- derived from so the deadline still matches the date shop staff have been working
-- toward. deadlineIsTight defaults true — the safer read: every legacy externalShipDate
-- was treated as a firm customer date.
UPDATE "Order"
SET "deadline" = COALESCE("externalShipDate", "internalDueDate" + INTERVAL '14 days');

ALTER TABLE "Order" DROP COLUMN "externalShipDate";
ALTER TABLE "Order" DROP COLUMN "internalDueDate";
