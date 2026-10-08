-- ScheduleAssignment now links to a ScheduleDraft and pins a wall-clock start
-- so the drag-and-drop board can persist positions.
ALTER TABLE "ScheduleAssignment"
    ADD COLUMN "startMinuteOfDay" INTEGER,
    ADD COLUMN "scheduleDraftId" TEXT;

ALTER TABLE "ScheduleAssignment"
    ADD CONSTRAINT "ScheduleAssignment_scheduleDraftId_fkey"
    FOREIGN KEY ("scheduleDraftId") REFERENCES "ScheduleDraft"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ScheduleAssignment_scheduleDraftId_idx"
    ON "ScheduleAssignment"("scheduleDraftId");

-- Order can carry a scheduler display override (title + color) without
-- touching customerName. Both nullable, both default to null.
ALTER TABLE "Order"
    ADD COLUMN "displayTitle" TEXT,
    ADD COLUMN "colorHex" TEXT;
