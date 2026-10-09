-- Editable formula constants (2026-09-28). One singleton row holds a JSON blob of every
-- rate/factor an admin can tune in Settings → Formulas; unset fields fall back to the
-- built-in defaults in $lib/server/engine/formulaSettings.ts, so no seed data is
-- required — an app that never touches this row still gets correct estimates.
CREATE TABLE "FormulaSettings" (
  "id"        TEXT PRIMARY KEY DEFAULT 'current',
  "formulas"  JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT
);
