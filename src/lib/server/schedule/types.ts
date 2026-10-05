/**
 * Shared input types for this folder. Dates are plain "YYYY-MM-DD" strings (not Date) so
 * MCP tool input schemas stay JSON-Schema-representable — convert with `new Date(...)`
 * before handing them to Prisma (see getSchedule.ts).
 */
import { z } from 'zod';

/** An inclusive date range: both `from` and `to` days are part of it. */
export const dateRangeSchema = z.object({
	from: z.iso.date(),
	to: z.iso.date()
});

export type DateRange = z.infer<typeof dateRangeSchema>;
