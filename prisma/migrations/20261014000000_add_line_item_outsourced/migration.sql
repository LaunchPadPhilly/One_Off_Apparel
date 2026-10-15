-- Patch Install outsource-or-3min question (2026-10-14).
-- See LineItem.outsourced in prisma/schema.prisma and src/lib/schedule/patchInstall.ts
-- for the business rule. Nullable: legacy OTHER rows (including existing Patch Install
-- line items imported before this change) default to NULL so their next review
-- surfaces the question.
ALTER TABLE "LineItem" ADD COLUMN "outsourced" BOOLEAN;
