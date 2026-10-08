-- Data-only (client decision 2026-09-28): artwork is always considered approved, so
-- it no longer gates confirming or scheduling. Mark every existing decoration row
-- approved so stored data matches; nothing reads the field as a gate any more.
UPDATE "LineItem"
SET "artworkApprovalStatus" = 'APPROVED'::"ArtworkApprovalStatus"
WHERE "itemType" = 'DECORATION'
  AND "artworkApprovalStatus" IS DISTINCT FROM 'APPROVED';
