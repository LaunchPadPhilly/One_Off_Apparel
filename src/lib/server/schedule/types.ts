import { z } from 'zod';

export const dateRangeSchema = z.object({
	from: z.iso.date(),
	to: z.iso.date()
});

export type DateRange = z.infer<typeof dateRangeSchema>;
