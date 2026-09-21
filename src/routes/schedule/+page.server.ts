import { fail } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { startAssignment } from '$lib/server/schedule/startAssignment';
import { stopAssignment } from '$lib/server/schedule/stopAssignment';
import { proposeAndPersistSchedule } from '$lib/server/schedule/proposeAndPersistSchedule';
import { groupAtRiskForDisplay } from '$lib/server/schedule/explainAtRisk';
import { commitSchedule } from '$lib/server/schedule/commitSchedule';
import { reassignProposedAssignment, removeProposedAssignment } from '$lib/server/schedule/reassignProposedAssignment';
import { listDrafts } from '$lib/server/schedule/draft';
import { ScheduleAssignmentStatus } from '../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

const DEFAULT_WINDOW_DAYS = 28; // "3-4 weeks out" per the ask — not a documented spec.

function isoDate(date: Date) {
	return date.toISOString().slice(0, 10);
}

/**
 * Provisional Production/Schedule board — see CLAUDE.md's "Production board
 * (provisional)" open item. Shows proposed + approved + in-progress assignments over a
 * 3-4 week window (default 28 days from today; ?from=&to= override), grouped by date.
 * Layout/grouping and the route path are still not a real spec, just extended
 * scaffolding — the same caveat as before, now covering more of the flow (propose →
 * approve/edit/remove, not just day-of Start/Stop).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);

	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const defaultTo = new Date(today);
	defaultTo.setUTCDate(defaultTo.getUTCDate() + (DEFAULT_WINDOW_DAYS - 1));

	const from = url.searchParams.get('from') ?? isoDate(today);
	const to = url.searchParams.get('to') ?? isoDate(defaultTo);

	const [assignments, stations, drafts] = await Promise.all([
		prisma.scheduleAssignment.findMany({
			where: {
				date: { gte: new Date(from), lte: new Date(to) },
				status: { in: [ScheduleAssignmentStatus.PROPOSED, ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] }
			},
			include: {
				lineItem: {
					select: {
						id: true,
						design: true,
						itemType: true,
						decorationType: true,
						finishingStep: true,
						orderId: true,
						order: { select: { hoopsOrderId: true, customerName: true } }
					}
				},
				station: { select: { id: true, name: true } }
			},
			orderBy: [{ date: 'asc' }, { stationId: 'asc' }, { sequenceOrder: 'asc' }]
		}),
		prisma.station.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
		// NEW: named draft schedules from the schedule-creation-workflow branch —
		// a separate precursor flow (build a named candidate schedule at /schedule/new,
		// review it at /schedule/drafts/[id]) that doesn't replace this page's existing
		// propose/approve/reassign/remove flow, just gives it another on-ramp.
		listDrafts()
	]);

	const byDate = new Map<string, typeof assignments>();
	for (const assignment of assignments) {
		const key = isoDate(assignment.date);
		byDate.set(key, [...(byDate.get(key) ?? []), assignment]);
	}

	return {
		canAct: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'),
		canCreate: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'),
		from,
		to,
		stations,
		days: [...byDate.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, dayAssignments]) => ({
				date,
				assignments: dayAssignments.map((assignment) => ({
					id: assignment.id,
					status: assignment.status,
					estimatedHours: assignment.estimatedHours,
					startedAt: assignment.startedAt?.toISOString() ?? null,
					stationId: assignment.station.id,
					station: assignment.station,
					lineItem: assignment.lineItem
				}))
			})),
		drafts: drafts.map((draft) => ({
			id: draft.id,
			name: draft.name,
			startDate: draft.startDate.toISOString().slice(0, 10),
			weeks: draft.weeks,
			strategy: draft.strategy,
			status: draft.status,
			createdBy: draft.createdBy,
			createdAt: draft.createdAt.toISOString()
		}))
	};
};

export const actions: Actions = {
	propose: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const from = data.get('from');
		const to = data.get('to');
		if (typeof from !== 'string' || typeof to !== 'string') return fail(400, { message: 'from/to are required' });

		try {
			const result = await proposeAndPersistSchedule({ from, to }, user.email);
			const atRiskGroups = await groupAtRiskForDisplay(result.atRisk);
			return {
				placedCount: result.assignments.length,
				consideredCount: result.assignments.length + result.atRisk.length,
				atRiskGroups
			};
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	commit: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentIds = data.getAll('assignmentIds').filter((value): value is string => typeof value === 'string' && value.length > 0);
		if (assignmentIds.length === 0) return fail(400, { message: 'Select at least one proposed assignment to approve.' });

		try {
			await commitSchedule(assignmentIds, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	reassign: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		const stationId = data.get('stationId');
		const date = data.get('date');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await reassignProposedAssignment(
				assignmentId,
				{
					stationId: typeof stationId === 'string' && stationId ? stationId : undefined,
					date: typeof date === 'string' && date ? date : undefined
				},
				user.email
			);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	remove: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await removeProposedAssignment(assignmentId, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	start: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await startAssignment(assignmentId, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	stop: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await stopAssignment(assignmentId, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	}
};
