-- The colors going on the piece (ink / thread / patch colors from the export's
-- "Color(s)" column), shown to the shop (2026-09-28). Additive, display-only.

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "decorationColors" TEXT;
