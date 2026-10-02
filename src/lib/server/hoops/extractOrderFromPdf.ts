import { env } from '$env/dynamic/private';
import Anthropic from '@anthropic-ai/sdk';
import { orderCandidateSchema, lineItemCandidateSchema, type OrderCandidate } from './types';

/**
 * There is no deterministic Hoops export parser — CLAUDE.md's Known open items are
 * explicit that the format isn't validated at scale, and several concrete gaps only
 * showed up once real samples existed (see "Real Hoops export samples now exist" in
 * CLAUDE.md). Extraction reads the PDF via the Claude Messages API instead of a
 * hand-rolled text/layout parser, matching CLAUDE.md's own design ("Claude reads the
 * export"). This makes it real, LLM-driven extraction with real per-import cost — not a
 * guaranteed-correct parser. Every extraction includes reviewConfidence per line item
 * and order-level confidenceFlags; the human confirmation gate (confirm_import) is not
 * optional scaffolding here, it's load-bearing.
 */

const MODEL = 'claude-sonnet-5';

export class PdfExtractionError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'PdfExtractionError';
	}
}

// Hand-written, not derived from orderCandidateSchema — Claude's tool-use JSON Schema
// support doesn't need to round-trip the zod refinements (itemType-conditional
// exclusivity, etc.); those are re-validated by orderCandidateSchema.parse() below
// once the tool call returns. Keep the two in sync by hand if the schema changes.
const extractionTool: Anthropic.Tool = {
	name: 'emit_extracted_order',
	description: "Emit the one order this Hoops export PDF describes, in this system's canonical shape.",
	input_schema: {
		type: 'object',
		properties: {
			hoopsOrderId: { type: 'string', description: 'The "Job <number>" identifier, e.g. "100127".' },
			customerName: { type: 'string' },
			deadline: {
				type: 'string',
				description:
					'ISO date YYYY-MM-DD. Use the "Deadline" date. If the export has no Deadline, return an empty string — never substitute another date such as the job creation "Date". This system stores exactly one date per order; there is no separate "internal" or "external" date any more.'
			},
			confidenceFlags: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Free-text notes on anything uncertain or excluded: OTHER rows (a job type with no schema match, e.g. "Patch Install"), a missing Deadline, administrative fee or supply rows excluded (e.g. digitizing fee, ink color change), missing weight_class signal, print_location that did not fit front/back/left/right.'
			},
			lineItems: {
				type: 'array',
				description:
					'One entry per decoration or finishing treatment — NOT per garment/blank row. A garment with two prints is two line items. Administrative fee rows (digitizing fee, ink color change, etc.) are never line items — exclude them and note it in confidenceFlags instead.',
				items: {
					type: 'object',
					properties: {
						localId: { type: 'string', description: 'Any unique string within this order, e.g. "1", "2" — used to wire dependsOn before real ids exist.' },
						itemType: { type: 'string', enum: ['DECORATION', 'FINISHING', 'OTHER'], description: 'OTHER for production work that matches no decorationType or finishingStep (e.g. "Patch Install").' },
						otherJobType: { type: ['string', 'null'], description: 'OTHER rows only: the treatment name as written in the export, e.g. "Patch Install". Null otherwise.' },
						design: { type: 'string', description: 'What the design is, including any design code shown (e.g. "HooDoo stacked script logo (AA2965)").' },
						printLocation: {
							type: ['string', 'null'],
							enum: ['FRONT', 'BACK', 'LEFT', 'RIGHT', null],
							description: 'Only if the export\'s position clearly maps to one of these four. "Right of Back Seam", "Sleeve/Collar" etc. do not — use null and note the raw position text in confidenceFlags instead of guessing.'
						},
						decorationType: { type: ['string', 'null'], enum: ['SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG', null], description: 'DECORATION rows only, else null.' },
						finishingStep: { type: ['string', 'null'], enum: ['MATTE', 'RELABEL', 'FOLD_BAG', 'HANG_TAG', 'WOVENS', null], description: 'FINISHING rows only, else null. WOVENS = sewing in woven labels.' },
						matteSurface: {
							type: ['string', 'null'],
							enum: ['FLAT', 'SPECIALTY', null],
							description: 'MATTE rows only, and only if the export clearly says whether the matte goes on a flat or specialty surface. Otherwise null and note it in confidenceFlags — never guess.'
						},
						foldBagGarment: {
							type: ['string', 'null'],
							enum: ['SS_TEE', 'OTHER', null],
							description: 'FOLD_BAG rows only. SS_TEE if the garment being bagged is clearly a short-sleeve tee, OTHER if it is clearly something else (hoodie, long sleeve, hat...). Null if unclear.'
						},
						dependsOn: {
							type: ['string', 'null'],
							description:
								'MATTE rows: the localId of the decoration this matte finishes. FOLD_BAG rows: the literal string "all_siblings". Null for RELABEL, HANG_TAG, WOVENS and DECORATION rows.'
						},
						weightClass: {
							type: 'string',
							enum: ['THIN', 'POLY', 'BULKY'],
							description:
								'From an inline hint like "(Thin - ...)" or "(Fleece/Bulky)" when present. If the product has no such hint (e.g. headwear), there is no correct value yet — default to "THIN" and you MUST add a confidenceFlags entry naming this line item and saying no weight-class signal existed.'
						},
						apparelColor: { type: 'string' },
						inkColorCount: { type: ['integer', 'null'], description: 'From "N Color Screen Print" or similar. Null if not applicable.' },
						decorationColors: {
							type: ['string', 'null'],
							description:
								'The colors going ON the piece for this decoration — the ink, thread or patch colors from the decoration row "Color(s)" column, as written, comma-separated (e.g. "109c Yellow, White", "Blue Patch"). NOT the color of the garment itself (that is apparelColor). Null for finishing rows or when none are listed.'
						},
						screens: {
							type: ['integer', 'null'],
							description: 'Only if stated explicitly. If screen print but not stated, default to inkColorCount and add a confidenceFlags note that screens was assumed equal to ink color count.'
						},
						stitchCount: { type: ['integer', 'null'], description: 'From "(N Stitches)" for embroidery. Null otherwise.' },
						quantity: { type: 'integer', description: 'Total units across all sizes for this specific decoration/finishing treatment.' },
						sizeBreakdown: { type: 'object', description: 'Map of size -> quantity, e.g. {"S": 30, "M": 41}.', additionalProperties: { type: 'integer' } },
						reviewConfidence: { type: 'number', minimum: 0, maximum: 1, description: '0-1. Lower whenever any field above was defaulted/guessed rather than read directly.' }
					},
					required: ['localId', 'itemType', 'design', 'weightClass', 'apparelColor', 'quantity', 'sizeBreakdown']
				}
			}
		},
		required: ['hoopsOrderId', 'customerName', 'deadline', 'lineItems']
	}
};

const SYSTEM_PROMPT = `You extract structured order data from a "Job" PDF exported from Hoops, a shop-management tool this apparel decorator uses. Each PDF describes exactly one job/order. Read it carefully:

- The "Job <number>" line is the order identifier.
- The job details table is organized into repeating groups: one blank/garment block (Code, Name/Description, Vendor, Color, Size, Quantity rows — one row per size) followed by one or more decoration/finishing rows (Name/Description, Vendor, Position, Color(s), Size, Quantity). Each decoration or finishing row is its own line item, sharing the same order — NOT one line item per garment/size row.
- A matte finishing row depends on the decoration it finishes within the same garment group — wire dependsOn to that decoration's localId. Fold & bag always waits on everything ("all_siblings"). Relabel, hang tags and wovens wait on nothing — leave their dependsOn null. (The system enforces these rules itself; this just keeps your output consistent with them.)
- Never invent a value you cannot support from the text. When something doesn't fit the schema (an unmapped treatment type, a missing signal, an ambiguous position), say so in confidenceFlags rather than guessing silently. This system's whole design assumes a human reviews everything you extract before it becomes real — your job is to make what you're unsure about visible, not to be right about everything.
- If a treatment is real production work but has no matching decorationType or finishingStep (e.g. "Patch Install" — it's neither screen print/embroidery/DTF/DTG nor matte/relabel/fold&bag/hang tag/wovens), include it as itemType "OTHER" with otherJobType set to its name as written (e.g. "Patch Install"), decorationType and finishingStep null, and note it in confidenceFlags. Never force it into a type it isn't; a reviewer will assign its station and hours.
- Rows that aren't production work on garments — administrative fees (digitizing fee, ink color change) and supply/material lines (e.g. "75 units of patches", leftover patches for the customer) — are never line items. Leave them out and mention them in confidenceFlags.
- If there is no "Deadline", return an empty deadline and say so in confidenceFlags. Never use another date instead.

Call emit_extracted_order exactly once with everything you found.`;

export async function extractOrderFromPdf(pdfBase64: string, filename: string): Promise<OrderCandidate & { confidenceFlags: string[] }> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new PdfExtractionError('ANTHROPIC_API_KEY is required for PDF import extraction');

	const client = new Anthropic({ apiKey });

	let response;
	try {
		response = await client.messages.create({
			model: MODEL,
			// Room for large orders: Job 100128 (24 line items) needs ~3.7k output tokens,
			// right at the old 4096 cap, and intermittently got cut off mid-list (2026-09-23).
			max_tokens: 16000,
			system: SYSTEM_PROMPT,
			tools: [extractionTool],
			tool_choice: { type: 'tool', name: extractionTool.name },
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
						{ type: 'text', text: `Extract this order from "${filename}".` }
					]
				}
			]
		});
	} catch (error) {
		throw new PdfExtractionError(`Claude API call failed while extracting "${filename}"`, error);
	}

	// A cut-off response has a partial tool input (typically no lineItems at all), which
	// would otherwise surface as a misleading "failed schema validation" error.
	if (response.stop_reason === 'max_tokens') {
		throw new PdfExtractionError(`"${filename}" is too large to extract in one response (Claude's answer was cut off). Try importing it again; if it keeps happening, the order may need splitting.`);
	}

	const toolUse = response.content.find((block) => block.type === 'tool_use');
	if (!toolUse || toolUse.type !== 'tool_use') {
		throw new PdfExtractionError(`Claude did not return structured extraction for "${filename}" (stop_reason: ${response.stop_reason})`);
	}

	const raw = toolUse.input as Record<string, unknown>;
	const importedBy = 'claude';
	const confidenceFlags = [...((raw.confidenceFlags as string[] | undefined) ?? [])];

	// Validate line items individually rather than all-or-nothing: a model that ignores
	// the "leave unmapped treatments out entirely" instruction and includes one anyway
	// (e.g. "Patch Install" with no decorationType) should lose that one line item, not
	// the whole order. See CLAUDE.md's Known open items — this happened for real on
	// Job 100113.
	const rawLineItems = Array.isArray(raw.lineItems) ? raw.lineItems : [];
	const lineItems = [];
	for (const [index, item] of rawLineItems.entries()) {
		const result = lineItemCandidateSchema.safeParse(item);
		if (result.success) {
			lineItems.push(result.data);
		} else {
			const design = typeof (item as Record<string, unknown>)?.design === 'string' ? (item as { design: string }).design : `line item ${index + 1}`;
			confidenceFlags.push(
				`Excluded "${design}" — extracted but didn't fit the schema (${result.error.issues.map((issue) => issue.message).join('; ')}). Needs manual entry if it's real work.`
			);
		}
	}

	// Nothing incomplete should stop an order reaching Orders for review (2026-09-28).
	// Some exports have no "Deadline" (e.g. Job 100160 only has its creation "Date"):
	// import with no deadline, and the order page asks for it. (Computing a due date
	// from a non-ISO string used to crash the whole import with "Invalid time value".)
	const rawDeadline = typeof raw.deadline === 'string' ? raw.deadline.trim() : '';
	const deadline = isIsoDate(rawDeadline) ? rawDeadline : null;
	if (!deadline) {
		confidenceFlags.push(`No Deadline date could be read from the export${rawDeadline ? ` (read "${rawDeadline}")` : ''} — enter the deadline on the order page.`);
	}

	// Same idea for the two identifying fields: fall back rather than refuse. The job
	// number is also in the file name ("Job 100157 - …"); only a file with neither is
	// refused, since an order must be identifiable to be imported or re-imported.
	const hoopsOrderId = (typeof raw.hoopsOrderId === 'string' && raw.hoopsOrderId.trim()) || /Job\s*(\d+)/i.exec(filename)?.[1] || '';
	if (!hoopsOrderId) throw new PdfExtractionError(`"${filename}" has no Job number Claude could read, so it can't be matched to a Hoops job.`);
	let customerName = typeof raw.customerName === 'string' ? raw.customerName.trim() : '';
	if (!customerName) {
		customerName = 'Unknown customer';
		confidenceFlags.push('No customer name could be read from the export — fill it in on the order page.');
	}

	try {
		// Imported Hoops "Deadline" dates are firm customer commitments, so imports
		// default deadlineIsTight = true. A reviewer flips to loose on the order page.
		const validated = orderCandidateSchema.parse({ ...raw, hoopsOrderId, customerName, deadline, deadlineIsTight: true, importedBy, lineItems });
		return { ...validated, confidenceFlags };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// Include why line items were dropped — otherwise an order that loses every line
		// item just reports "expected array to have >=1 items" with no hint of the cause.
		const dropped = confidenceFlags.filter((flag) => flag.startsWith('Excluded "'));
		throw new PdfExtractionError(
			`"${filename}" extracted but failed schema validation even after dropping bad line items: ${detail}${dropped.length ? ` — dropped: ${dropped.join(' | ')}` : ''}`,
			error
		);
	}
}

/** A real calendar date in "YYYY-MM-DD" form (rejects e.g. "2026-02-30" and "29 Sep. 2026"). */
function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
