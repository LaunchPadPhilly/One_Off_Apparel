-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "McpScope" ADD VALUE 'SCHEDULE_READ';
ALTER TYPE "McpScope" ADD VALUE 'IMPORT_WRITE';
ALTER TYPE "McpScope" ADD VALUE 'SCHEDULE_WRITE';
