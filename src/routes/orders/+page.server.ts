import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { prisma } from '$lib/server/prisma';
import { estimateHours, MissingFormulaError } from '$lib/server/engine/estimateHours';
import {
	ArtworkApprovalStatus,
	BlankOrderingStatus,
	CustomerApprovalStatus,
	LineItemStatus,
	LineItemType,
	OrderStatus,
	DecorationType,
	PrintLocation,
	WeightClass
} from '../../../prisma/generated/prisma/enums';
import { FinishingStep } from '../../../prisma/generated/prisma/enums';

const COLUMN_ALIASES: Record<string, string> = {
	job_number: 'job_number',
	job: 'job_number',
	customer: 'customer_name',
	customer_name: 'customer_name',
	deadline: 'external_ship_date',
	external_ship_date: 'external_ship_date',
	ship_date: 'external_ship_date',
	internal_due_date: 'internal_due_date',
	due_date: 'internal_due_date',
	type: 'item_type',
	item_type: 'item_type',
	position: 'position',
	location: 'position',
	name_description: 'name_description',
	description: 'name_description',
	colors: 'colors',
	color: 'colors',
	ink_color: 'colors',
	apparel_color: 'apparel_color',
	garment_color: 'apparel_color',
	size: 'size',
	quantity: 'quantity',
	qty: 'quantity',
	color_count: 'color_count',
	screens: 'screens',
	weight_class: 'weight_class',
	stitch_count: 'stitch_count',
	thread_count: 'thread_count',
	line_item_id: 'line_item_id',
	code: 'code',
	vendor: 'vendor'
};

function normalizeHeader(raw: string): string {
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseCSV(text: string): Array<Record<string, string>> {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length < 2) return [];
	const rawHeaders = lines[0].split(',').map((h) => h.trim());
	const headers = rawHeaders.map((h) => {
		const normalized = normalizeHeader(h);
		return COLUMN_ALIASES[normalized] ?? normalized;
	});
	return lines.slice(1).map((line) => {
		const values = line.split(',').map((v) => v.trim());
		const row: Record<string, string> = {};
		headers.forEach((h, i) => (row[h] = values[i] ?? ''));
		return row;
	});
}

const DECORATION_TYPE_MAP: Record<string, DecorationType> = {
	screen_print: DecorationType.SCREEN_PRINT,
	print: DecorationType.SCREEN_PRINT,
	embroidery: DecorationType.EMBROIDERY,
	dtf: DecorationType.DTF,
	dtg: DecorationType.DTG
};

const PRINT_LOCATION_MAP: Record<string, PrintLocation> = {
	front: PrintLocation.FRONT,
	'front lc': PrintLocation.FRONT,
	back: PrintLocation.BACK,
	left: PrintLocation.LEFT,
	'left lc': PrintLocation.LEFT,
	right: PrintLocation.RIGHT,
	'right lc': PrintLocation.RIGHT
};

const FINISHING_STEP_MAP: Record<string, FinishingStep> = {
	matte_finish: FinishingStep.MATTE,
	hang_tags: FinishingStep.HANG_TAG,
	fold_bag: FinishingStep.FOLD_BAG,
	printed_relabel: FinishingStep.RELABEL,
	woven_label: FinishingStep.RELABEL
};

const FINISHING_TYPE_KEYS = new Set([...Object.keys(FINISHING_STEP_MAP), 'finishing']);

const WEIGHT_CLASS_MAP: Record<string, WeightClass> = {
	thin: WeightClass.THIN,
	poly: WeightClass.POLY,
	bulky: WeightClass.BULKY
};

interface ParsedLineItem {
	csvLineId: string;
	design: string;
	itemType: LineItemType;
	decorationType: DecorationType | null;
	finishingStep: FinishingStep | null;
	printLocation: PrintLocation | null;
	weightClass: WeightClass;
	apparelColor: string;
	inkColorCount: number | null;
	screens: number | null;
	stitchCount: number | null;
	quantity: number;
	estimate: { station: string; hours: number } | { error: string } | undefined;
	warnings: string[];
}

interface ParsedOrder {
	hoopsOrderId: string;
	customerName: string;
	externalShipDate: string;
	internalDueDate: string;
	lineItems: ParsedLineItem[];
	warnings: string[];
}

function inferWeightClass(description: string): WeightClass | null {
	const d = description.toLowerCase();
	if (/hoodie|sweatshirt|fleece|jacket|heavyweight|pullover|crew\s?neck\s?sweat/i.test(d)) return WeightClass.BULKY;
	if (/poly|performance|moisture|athletic|dry\s?fit/i.test(d)) return WeightClass.POLY;
	if (/tee|t-shirt|tshirt|tri-?blend|tank|lightweight|shirt/i.test(d)) return WeightClass.THIN;
	return null;
}

function extractColorCount(description: string): number | null {
	const m = description.match(/(\d+)\s*colou?r/i);
	return m ? parseInt(m[1]) : null;
}

function parseRows(rows: Array<Record<string, string>>): { orders: ParsedOrder[]; errors: string[] } {
	const errors: string[] = [];
	if (rows.length === 0) {
		errors.push('CSV is empty or has no data rows.');
		return { orders: [], errors };
	}

	const grouped = new Map<string, Array<Record<string, string>>>();
	for (const row of rows) {
		const jobNumber = row['job_number'] ?? '';
		if (!jobNumber) {
			errors.push(`Row missing job_number: ${JSON.stringify(row)}`);
			continue;
		}
		if (!grouped.has(jobNumber)) grouped.set(jobNumber, []);
		grouped.get(jobNumber)!.push(row);
	}

	const orders: ParsedOrder[] = [];
	for (const [jobNumber, jobRows] of grouped) {
		const orderWarnings: string[] = [];
		const firstRow = jobRows[0];

		const customerName = firstRow['customer_name'] || '';
		if (!customerName) orderWarnings.push('Missing customer_name — will need to be added manually.');

		const externalShipDate = firstRow['external_ship_date'] || '';
		if (!externalShipDate) orderWarnings.push('Missing external_ship_date — required for scheduling.');

		const internalDueDate = firstRow['internal_due_date'] || '';
		if (!internalDueDate) orderWarnings.push('Missing internal_due_date — required for scheduling.');

		// Separate garment rows from decoration/finishing rows
		const garmentRows: Array<Record<string, string>> = [];
		const workRows: Array<Record<string, string>> = [];
		for (const row of jobRows) {
			const rawType = (row['item_type'] || '').toLowerCase();
			if (rawType === 'garment') {
				garmentRows.push(row);
			} else {
				workRows.push(row);
			}
		}

		// Extract garment info (apparel_color, weight_class) from garment rows
		let garmentColor = '';
		let garmentWeightClass: WeightClass | null = null;
		let garmentQuantity = 0;
		for (const g of garmentRows) {
			if (g['apparel_color'] && !garmentColor) garmentColor = g['apparel_color'];
			if (g['colors'] && !garmentColor) garmentColor = g['colors'];
			const desc = g['name_description'] || '';
			if (!garmentWeightClass) garmentWeightClass = inferWeightClass(desc);
			garmentQuantity += parseInt(g['quantity'] || '0') || 0;
		}

		// If there are ONLY garment rows and no decoration rows, skip — nothing to schedule
		if (workRows.length === 0 && garmentRows.length > 0) {
			orderWarnings.push('Only garment rows found — no decoration or finishing lines to schedule.');
		}

		const lineItems: ParsedLineItem[] = [];
		for (const row of (workRows.length > 0 ? workRows : jobRows)) {
			const rawType = (row['item_type'] || '').toLowerCase();
			if (rawType === 'garment') continue;

			const warnings: string[] = [];
			const csvLineId = row['line_item_id'] || '';
			const isFinishing = FINISHING_TYPE_KEYS.has(rawType);

			const decorationType = isFinishing ? null : (DECORATION_TYPE_MAP[rawType] ?? null);
			if (!isFinishing && !decorationType) {
				warnings.push(`Unknown decoration type "${rawType}" — defaulting to SCREEN_PRINT.`);
			}
			const finishingStep = isFinishing ? (FINISHING_STEP_MAP[rawType] ?? null) : null;

			const rawPosition = (row['position'] || '').toLowerCase();
			const printLocation = PRINT_LOCATION_MAP[rawPosition] ?? null;
			if (!isFinishing && rawPosition && !printLocation) {
				warnings.push(`Could not map position "${row['position']}" to a print location.`);
			}

			const rawWeight = (row['weight_class'] || '').toLowerCase();
			let weightClass = WEIGHT_CLASS_MAP[rawWeight] ?? null;
			if (!weightClass && garmentWeightClass) {
				weightClass = garmentWeightClass;
			}
			if (!weightClass) {
				weightClass = WeightClass.THIN;
				warnings.push('Missing weight_class — defaulting to THIN. Add weight_class column (thin/poly/bulky) for accurate estimates.');
			}

			// apparel_color: prefer explicit apparel_color, then garment row info
			// On decoration rows, the "colors"/"color" column is the ink color, not apparel
			let apparelColor = row['apparel_color'] || '';
			if (!apparelColor && garmentColor) {
				apparelColor = garmentColor;
			}
			if (!apparelColor && !isFinishing) {
				warnings.push('No apparel_color found — could not determine garment color from CSV.');
			}

			const quantity = parseInt(row['quantity'] || '0') || garmentQuantity || 0;
			if (quantity <= 0) warnings.push('Quantity is 0 or missing.');

			let inkColorCount = parseInt(row['color_count'] || '0') || null;
			const desc = row['name_description'] || '';
			if (!inkColorCount) {
				inkColorCount = extractColorCount(desc);
			}

			let screensVal = parseInt(row['screens'] || '0') || null;
			if (!screensVal && inkColorCount && (decorationType === DecorationType.SCREEN_PRINT || rawType === 'print')) {
				screensVal = inkColorCount + 1;
			}
			if (!screensVal && (decorationType === DecorationType.SCREEN_PRINT || rawType === 'print')) {
				warnings.push('Could not determine screens count — no color_count or screens column, and description did not contain a color count.');
			}
			const stitchCount = parseInt(row['stitch_count'] || '0') || null;
			const threadCount = parseInt(row['thread_count'] || '0') || null;

			const itemType = isFinishing ? LineItemType.FINISHING : LineItemType.DECORATION;
			const resolvedDecorationType = isFinishing ? null : (decorationType ?? DecorationType.SCREEN_PRINT);

			let estimate: { station: string; hours: number } | { error: string } | undefined;
			try {
				estimate = estimateHours({
					itemType,
					decorationType: resolvedDecorationType,
					finishingStep,
					inkColorCount: inkColorCount ?? threadCount,
					screens: screensVal,
					stitchCount,
					quantity,
					weightClass
				});
			} catch (e) {
				if (e instanceof MissingFormulaError) {
					estimate = { error: e.message };
				}
			}

			lineItems.push({
				csvLineId,
				design: row['name_description'] || '',
				itemType,
				decorationType: resolvedDecorationType,
				finishingStep,
				printLocation,
				weightClass,
				apparelColor,
				inkColorCount: inkColorCount ?? threadCount,
				screens: screensVal,
				stitchCount,
				quantity,
				estimate,
				warnings
			});
		}

		orders.push({
			hoopsOrderId: jobNumber,
			customerName,
			externalShipDate,
			internalDueDate,
			lineItems,
			warnings: orderWarnings
		});
	}

	return { orders, errors };
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const orders = await prisma.order.findMany({
		include: {
			lineItems: {
				orderBy: { id: 'asc' }
			}
		},
		orderBy: { createdAt: 'desc' }
	});

	return { orders };
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const file = form.get('csvFile') as File | null;

		if (!file || file.size === 0) return { error: 'Please select a CSV file.' };

		const text = await file.text();
		const rows = parseCSV(text);
		const { orders: parsed, errors } = parseRows(rows);

		if (errors.length > 0) return { error: errors.join(' ') };
		if (parsed.length === 0) return { error: 'No valid orders found in CSV.' };

		return { preview: parsed };
	},

	confirm: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const ordersJson = form.get('ordersData') as string;

		let parsed: ParsedOrder[];
		try {
			parsed = JSON.parse(ordersJson);
		} catch {
			return { error: 'Invalid order data.' };
		}

		const created: string[] = [];
		for (const orderData of parsed) {
			const customerName = (form.get(`customer_${orderData.hoopsOrderId}`) as string) || orderData.customerName || orderData.hoopsOrderId;
			const externalShipDate = (form.get(`shipDate_${orderData.hoopsOrderId}`) as string) || orderData.externalShipDate;
			const internalDueDate = (form.get(`dueDate_${orderData.hoopsOrderId}`) as string) || orderData.internalDueDate;

			if (!externalShipDate || !internalDueDate) {
				return { error: `Order ${orderData.hoopsOrderId}: ship date and due date are required.` };
			}

			await prisma.order.create({
				data: {
					hoopsOrderId: orderData.hoopsOrderId,
					customerName,
					externalShipDate: new Date(externalShipDate),
					internalDueDate: new Date(internalDueDate),
					status: OrderStatus.NEEDS_REVIEW,
					blankOrderingStatus: BlankOrderingStatus.NOT_ORDERED,
					customerApprovalStatus: CustomerApprovalStatus.NOT_SENT,
					importedBy: locals.user.email,
					lineItems: {
						create: orderData.lineItems.map((item) => ({
							itemType: item.itemType,
							design: item.design,
							printLocation: item.printLocation,
							decorationType: item.decorationType,
							finishingStep: item.finishingStep,
							dependsOn: null,
							status: item.itemType === 'FINISHING' ? LineItemStatus.BLOCKED : LineItemStatus.NEEDS_REVIEW,
							artworkApprovalStatus: item.itemType === 'FINISHING' ? null : ArtworkApprovalStatus.NOT_SUBMITTED,
							weightClass: item.weightClass,
							apparelColor: item.apparelColor,
							inkColorCount: item.inkColorCount,
							screens: item.screens,
							stitchCount: item.stitchCount,
							quantity: item.quantity,
							sizeBreakdown: {},
							estimatedHours: item.estimate
						}))
					}
				}
			});
			created.push(orderData.hoopsOrderId);
		}

		return { success: true, created };
	},

	updateStatus: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const orderId = form.get('orderId') as string;
		const field = form.get('field') as string;
		const value = form.get('value') as string;

		if (!orderId || !field || !value) return { error: 'Missing required fields.' };

		const allowed: Record<string, string[]> = {
			status: ['NEEDS_REVIEW', 'CONFIRMED', 'SCHEDULED', 'IN_PRODUCTION', 'COMPLETE'],
			blankOrderingStatus: ['NOT_ORDERED', 'ORDERED', 'ISSUE', 'RECEIVED'],
			customerApprovalStatus: ['NOT_SENT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED']
		};

		if (!allowed[field]?.includes(value)) return { error: `Invalid value "${value}" for field "${field}".` };

		await prisma.order.update({
			where: { id: orderId },
			data: { [field]: value }
		});

		return { success: true };
	},

	updateArtwork: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const lineItemId = form.get('lineItemId') as string;
		const value = form.get('value') as string;

		const allowed = ['NOT_SUBMITTED', 'PENDING_APPROVAL', 'REVISION_REQUESTED', 'APPROVED'];
		if (!lineItemId || !allowed.includes(value)) return { error: 'Invalid artwork status.' };

		await prisma.lineItem.update({
			where: { id: lineItemId },
			data: { artworkApprovalStatus: value as ArtworkApprovalStatus }
		});

		return { success: true };
	},

	deleteOrder: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const orderId = form.get('orderId') as string;
		if (!orderId) return { error: 'Missing order ID.' };

		await prisma.lineItem.deleteMany({ where: { orderId } });
		await prisma.order.delete({ where: { id: orderId } });

		return { success: true };
	}
};
