import { error } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { getDraft } from '$lib/server/schedule/draft';
import { prisma } from '$lib/server/prisma';
import { OrderStatus } from '../../../../../prisma/generated/prisma/enums';
import type { PageServerLoad } from './$types';

// Working time in the shop's standard shift: 8:00–4:30 (8.5h) minus one
// 30-minute lunch and two 15-minute breaks. Kept in sync with the SHIFT
// constants on the client bar renderer.
const DEFAULT_STATION_DAY_HOURS = 7.5;
const KNOWN_STATIONS = [
	'screen_print_auto',
	'embroidery',
	'matte_finish',
	'fold_bag',
	'hang_tags',
	'printed_relabel'
] as const;

function iso(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): Date {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d;
}

/**
 * The draft detail view carries the sidebar (candidate orders + line items with
 * estimated hours) and the day-by-day timeline. Assignment rows are not linked to
 * ScheduleDraft yet — see prisma/schema.prisma. Until that FK lands, days render
 * empty and orders in the tray are just candidates.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);
	const draft = await getDraft(params.id);
	if (!draft) throw error(404, 'Schedule draft not found');

	const startIso = iso(draft.startDate);
	const endDate = addDays(startIso, draft.weeks * 7 - 1);
	const endIso = iso(endDate);

	const [orders, stations, capacityRows] = await Promise.all([
		prisma.order.findMany({
			where: { status: { not: OrderStatus.COMPLETE } },
			include: { lineItems: { orderBy: { id: 'asc' } } },
			orderBy: [{ internalDueDate: 'asc' }, { createdAt: 'desc' }]
		}),
		prisma.station.findMany({ orderBy: { name: 'asc' } }),
		prisma.capacityCalendar.findMany({
			where: { date: { gte: draft.startDate, lte: endDate } }
		})
	]);

	// One entry per (station, day) in the window; falls back to the default day
	// length when the capacity_calendar has no row for that pair. That keeps the
	// timeline usable before capacity_calendar has been seeded for a shop.
	const days: string[] = [];
	for (let i = 0; i < draft.weeks * 7; i++) {
		days.push(iso(addDays(startIso, i)));
	}
	const stationNames = stations.length
		? stations.map((station) => station.name)
		: [...KNOWN_STATIONS];
	const capacityMap = new Map<string, number>();
	for (const row of capacityRows) {
		capacityMap.set(`${row.stationId}:${iso(row.date)}`, row.availableHrs);
	}
	const stationIdByName = new Map(stations.map((station) => [station.name, station.id]));

	const capacity = days.map((day) => ({
		date: day,
		stations: stationNames.map((name) => {
			const stationId = stationIdByName.get(name);
			const hrs = stationId ? capacityMap.get(`${stationId}:${day}`) : undefined;
			return {
				name,
				availableHrs: hrs ?? DEFAULT_STATION_DAY_HOURS
			};
		})
	}));

	return {
		draft: {
			id: draft.id,
			name: draft.name,
			description: draft.description,
			startDate: startIso,
			endDate: endIso,
			weeks: draft.weeks,
			strategy: draft.strategy,
			status: draft.status,
			createdBy: draft.createdBy,
			createdAt: draft.createdAt.toISOString()
		},
		orders: orders.map((order) => ({
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			internalDueDate: iso(order.internalDueDate),
			externalShipDate: iso(order.externalShipDate),
			status: order.status,
			lineItems: order.lineItems.map((item) => ({
				id: item.id,
				design: item.design,
				itemType: item.itemType,
				decorationType: item.decorationType,
				finishingStep: item.finishingStep,
				printLocation: item.printLocation,
				apparelColor: item.apparelColor,
				inkColorCount: item.inkColorCount,
				quantity: item.quantity,
				status: item.status,
				estimatedHours: item.estimatedHours
			}))
		})),
		stationNames,
		capacity,
		defaultStationDayHours: DEFAULT_STATION_DAY_HOURS
	};
};
