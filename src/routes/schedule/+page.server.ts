import { fail } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { startAssignment } from '$lib/server/schedule/startAssignment';
import { stopAssignment } from '$lib/server/schedule/stopAssignment';
import { ScheduleAssignmentStatus } from '../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

/**
 * Placeholder Production Board — see CLAUDE.md's "Production board (provisional)" open
 * item. This route, its flat unlayout-ed list, and the /schedule path itself are all
 * explicitly provisional: no grouping (per-station/per-day/per-order), no design, no
 * date filtering — a bare list of every currently-actionable assignment, gated on the
 * same SCHEDULE_READ/SCHEDULE_WRITE scopes the domain MCP tools already use (see
 * src/lib/server/auth/guards.ts and +layout.svelte's scope-gated-nav-link convention).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);

	const assignments = await prisma.scheduleAssignment.findMany({
		where: { status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] } },
		include: {
			lineItem: { select: { id: true, design: true, itemType: true, decorationType: true, finishingStep: true, orderId: true } },
			station: { select: { id: true, name: true } }
		},
		orderBy: [{ stationId: 'asc' }, { sequenceOrder: 'asc' }]
	});

	return {
		canAct: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'),
		assignments: assignments.map((assignment) => ({
			id: assignment.id,
			status: assignment.status,
			date: assignment.date.toISOString().slice(0, 10),
			estimatedHours: assignment.estimatedHours,
			startedAt: assignment.startedAt?.toISOString() ?? null,
			station: assignment.station,
			lineItem: assignment.lineItem
		}))
	};
};

export const actions: Actions = {
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
