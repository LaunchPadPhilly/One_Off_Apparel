// Dev-only: create one confirmed order with a screen-print and an embroidery line
// item, a draft, and both items pre-placed. Lets you open the draft and drag the
// embroidery job onto the screen-print row to verify the drag-over-refusal fix.
// Safe to re-run — uses a stable hoopsOrderId and no-ops if the order exists.
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

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const HOOPS = 'DEV-9001';
const existing = await client.query(`SELECT id FROM "Order" WHERE "hoopsOrderId" = $1`, [HOOPS]);
if (existing.rowCount > 0) {
	console.log(`Order ${HOOPS} already exists — nothing to do.`);
	await client.end();
	process.exit(0);
}

const now = new Date().toISOString();
const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const orderId = `dev-order-9001`;
const li1 = `dev-li-sp-9001`;
const li2 = `dev-li-emb-9001`;

const stations = await client.query(
	`SELECT id, name, kind FROM "Station" WHERE name IN ('screen_print_auto', 'embroidery')`
);
const spStation = stations.rows.find((r) => r.name === 'screen_print_auto');
const embStation = stations.rows.find((r) => r.name === 'embroidery');
if (!spStation || !embStation) throw new Error('Expected seeded stations missing');

await client.query('BEGIN');

await client.query(
	`INSERT INTO "Order" ("id", "hoopsOrderId", "customerName", "deadline", "deadlineIsTight", "status", "importedBy", "createdAt")
	 VALUES ($1, $2, $3, $4::date, true, 'CONFIRMED', 'dev-seed', $5)`,
	[orderId, HOOPS, 'Dev test customer', deadline, now]
);

const sizeBreakdown = JSON.stringify({ S: 5, M: 10, L: 10 });
await client.query(
	`INSERT INTO "LineItem" ("id", "orderId", "itemType", "decorationType", "design", "quantity", "weightClass", "apparelColor", "sizeBreakdown", "inkColorCount", "screens", "status")
	 VALUES ($1, $2, 'DECORATION', 'SCREEN_PRINT', 'Front print', 25, 'THIN', 'Black', $3::jsonb, 2, 3, 'NEEDS_REVIEW')`,
	[li1, orderId, sizeBreakdown]
);
await client.query(
	`INSERT INTO "LineItem" ("id", "orderId", "itemType", "decorationType", "design", "quantity", "weightClass", "apparelColor", "sizeBreakdown", "stitchCount", "status")
	 VALUES ($1, $2, 'DECORATION', 'EMBROIDERY', 'Left-chest logo', 25, 'THIN', 'Black', $3::jsonb, 5000, 'NEEDS_REVIEW')`,
	[li2, orderId, sizeBreakdown]
);

const draftId = 'dev-draft-9001';
const startDate = new Date().toISOString().slice(0, 10);
await client.query(
	`INSERT INTO "ScheduleDraft" ("id", "name", "description", "startDate", "weeks", "strategy", "status", "createdBy", "createdAt", "updatedAt")
	 VALUES ($1, $2, $3, $4::date, 2, 'BATCH_OPTIMIZE', 'DRAFT', 'dev-seed', $5, $5)`,
	[draftId, 'Dev drag-drop test', 'Drag the embroidery job onto the screen-print row.', startDate, now]
);

await client.query(
	`INSERT INTO "ScheduleAssignment" ("id", "lineItemId", "stationId", "date", "sequenceOrder", "startMinuteOfDay", "estimatedHours", "status", "proposedBy", "scheduleDraftId")
	 VALUES ($1, $2, $3, $4::date, 1, 480, 1.5, 'PROPOSED', 'dev-seed', $5)`,
	['dev-asn-sp-9001', li1, spStation.id, startDate, draftId]
);
await client.query(
	`INSERT INTO "ScheduleAssignment" ("id", "lineItemId", "stationId", "date", "sequenceOrder", "startMinuteOfDay", "estimatedHours", "status", "proposedBy", "scheduleDraftId")
	 VALUES ($1, $2, $3, $4::date, 1, 480, 1.25, 'PROPOSED', 'dev-seed', $5)`,
	['dev-asn-emb-9001', li2, embStation.id, startDate, draftId]
);

await client.query('COMMIT');
console.log(`Seeded.`);
console.log(`  Order:   ${orderId} (hoops ${HOOPS})`);
console.log(`  Draft:   /schedule/drafts/${draftId}`);
console.log(`  Items:   ${li1} (screen print), ${li2} (embroidery)`);
await client.end();
