// Dev-only: re-space the UAT-snapshot draft so there's a 15-min wall-clock
// buffer between consecutive jobs on each station/day. Accounts for the shop
// breaks (10:00/15m, 12:30/30m, 15:00/15m) so a bar that straddles a break
// doesn't visually bump into the next bar. Overflow rolls to the next day.
import fs from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
	fs
		.readFileSync('.env.local', 'utf8')
		.split('\n')
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => {
			const i = l.indexOf('=');
			return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
		})
);

const DRAFT_ID = 'uat-snapshot-2026-10-13';
const SHIFT_START = 480; // 08:00
const SHIFT_END = 990; // 16:30
const BUFFER_MIN = 15;
const BREAKS = [
	{ startMin: 600, durationMin: 15 }, // 10:00 break
	{ startMin: 750, durationMin: 30 }, // 12:30 lunch
	{ startMin: 900, durationMin: 15 }  // 15:00 break
];

function wallClockEnd(startMin, workingMin) {
	let cursor = startMin;
	let remaining = workingMin;
	while (remaining > 0 && cursor < SHIFT_END) {
		const inBreak = BREAKS.find((b) => cursor >= b.startMin && cursor < b.startMin + b.durationMin);
		if (inBreak) {
			cursor = inBreak.startMin + inBreak.durationMin;
			continue;
		}
		const nextBreak = BREAKS.find((b) => b.startMin > cursor);
		const segmentEnd = nextBreak ? nextBreak.startMin : SHIFT_END;
		const available = segmentEnd - cursor;
		if (remaining <= available) {
			cursor += remaining;
			remaining = 0;
		} else {
			cursor = segmentEnd;
			remaining -= available;
		}
	}
	return cursor;
}

function skipBreak(minute) {
	const inBreak = BREAKS.find((b) => minute >= b.startMin && minute < b.startMin + b.durationMin);
	return inBreak ? inBreak.startMin + inBreak.durationMin : minute;
}

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const rows = (
	await client.query(
		`SELECT id, "stationId", date::text AS date, "sequenceOrder", "estimatedHours"
		 FROM "ScheduleAssignment"
		 WHERE "scheduleDraftId" = $1
		 ORDER BY "stationId", date, "sequenceOrder"`,
		[DRAFT_ID]
	)
).rows;

const groups = new Map();
for (const row of rows) {
	if (!groups.has(row.stationId)) groups.set(row.stationId, []);
	groups.get(row.stationId).push(row);
}

await client.query('BEGIN');
let moved = 0;
for (const [stationId, items] of groups) {
	items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sequenceOrder - b.sequenceOrder));
	let currentDate = items[0].date;
	let nextStart = SHIFT_START;
	let seq = 1;
	for (const item of items) {
		const dur = Math.max(15, Math.round(Number(item.estimatedHours) * 60));
		let start = skipBreak(nextStart);
		let end = wallClockEnd(start, dur);
		if (end > SHIFT_END) {
			const d = new Date(`${currentDate}T00:00:00Z`);
			d.setUTCDate(d.getUTCDate() + 1);
			currentDate = d.toISOString().slice(0, 10);
			seq = 1;
			start = SHIFT_START;
			end = wallClockEnd(start, dur);
		}
		await client.query(
			`UPDATE "ScheduleAssignment"
			 SET "startMinuteOfDay" = $1, date = $2::date, "sequenceOrder" = $3
			 WHERE id = $4`,
			[start, currentDate, seq, item.id]
		);
		moved += 1;
		// Next item starts 15 wall-clock minutes after this one's visible end,
		// skipping any break the buffer-end lands inside.
		nextStart = skipBreak(end + BUFFER_MIN);
		seq += 1;
	}
}
await client.query('COMMIT');

const after = (
	await client.query(
		`SELECT "sequenceOrder" AS seq, date::text AS date, "startMinuteOfDay" AS start, "estimatedHours" AS hrs
		 FROM "ScheduleAssignment"
		 WHERE "scheduleDraftId" = $1
		 ORDER BY date, "sequenceOrder"`,
		[DRAFT_ID]
	)
).rows;

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
console.log(`Re-spaced ${moved} assignments with a ${BUFFER_MIN}-min wall-clock buffer.`);
for (const r of after)
	console.log(`  ${r.date}  seq ${r.seq}: ${fmt(r.start)} → ${fmt(wallClockEnd(r.start, Math.round(Number(r.hrs) * 60)))}`);

await client.end();
