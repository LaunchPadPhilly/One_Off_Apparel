-- "Why did the approved schedule change?" notes (2026-10-16). One row per change to
-- committed (APPROVED / IN_PROGRESS) schedule work; a person adds the reason later.
-- draftId is a plain column, not a foreign key, so deleting a draft keeps its notes.

-- CreateTable
CREATE TABLE "schedule_change_notes" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "draftId" TEXT,
    "orderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "details" JSONB,
    "reason" TEXT,
    "reasonBy" TEXT,
    "reasonAt" TIMESTAMP(3),

    CONSTRAINT "schedule_change_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_change_notes_at_idx" ON "schedule_change_notes"("at");

-- CreateIndex
CREATE INDEX "schedule_change_notes_reasonAt_idx" ON "schedule_change_notes"("reasonAt");
