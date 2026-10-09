import { env } from '$env/dynamic/private';
import Anthropic from '@anthropic-ai/sdk';
import { orderCandidateSchema, lineItemCandidateSchema, type OrderCandidate } from './types';
import { HOOPS_EXTRACTION_RULES } from './extractionRules';

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
 *
 * Called from the Orders page's PDF upload action (src/routes/orders/+page.server.ts);
 * its output is then saved by importHoopsExport.ts. This file never writes to the
 * database itself.
 */

// Which Claude model reads the PDF. Real per-import cost — see CLAUDE.md's Known open
// items ("PDF extraction cost/model choice not confirmed with the client").
const MODEL = 'claude-sonnet-5';

/**
 * Thrown for any expected extraction failure (no API key, API call failed, the answer
 * was cut off or unusable, no Job number). Its message is written for the person who
 * uploaded the file; `cause` keeps the underlying error for debugging.
 */
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
//
// The `description` strings below are instructions Claude reads when filling in each
// field — changing their wording changes extraction behavior, so treat an edit to them
// like a code change (re-test against the sample Hoops PDFs).
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
						garmentStyle: {
							type: ['string', 'null'],
							enum: ['FLAT', 'CAP', null],
							description:
								'DECORATION rows only: the garment this decoration goes on, from its blank/garment block. CAP for headwear (cap, hat, snapback, trucker, visor, beanie); FLAT for everything else (tees, polos, hoodies, jackets, bags...). Null for finishing rows.'
						},
						capConstruction: {
							type: ['string', 'null'],
							enum: ['STRUCTURED', 'UNSTRUCTURED', null],
							description:
								'Only when garmentStyle is CAP: STRUCTURED or UNSTRUCTURED if the product name or description says so (e.g. "Structured Snapback", "Unstructured Dad Hat"). Null otherwise.'
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
						inkColorCount: { type: ['integer', 'null'], description: 'From "N Color Screen Print" or similar. If no count is stated, count the colors listed in the decoration row "Color(s)" column (e.g. "White thread" = 1, "109c Yellow, White" = 2). Null only if not applicable or the colors are not listed.' },
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

// The instructions sent to Claude with every PDF. Like the tool descriptions above,
// this is behavior, not documentation: re-test against the sample Hoops PDFs after any
// wording change. The rules it states (finishing dependencies, garment style, etc.) are
// also enforced in code after extraction — this just keeps Claude's output consistent.
const SYSTEM_PROMPT = `You extract structured order data from a "Job" PDF exported from Hoops, a shop-management tool this apparel decorator uses. Each PDF describes exactly one job/order. Read it carefully:

${HOOPS_EXTRACTION_RULES}

Call emit_extracted_order exactly once with everything you found.`;

/**
 * Sends one Hoops "Job" PDF to Claude and returns the order it describes, validated
 * against orderCandidateSchema, plus every confidence flag (Claude's own, and any added
 * here for dropped rows or missing fields). Does not save anything.
 *
 * @param pdfBase64 - the PDF file's bytes, base64-encoded
 * @param filename - the uploaded file's name; used in messages, and as a fallback
 *                   source for the Job number ("Job 100157 - …")
 * @throws PdfExtractionError when the order can't be extracted at all (see the class)
 */
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

	// Validate line items individually rather than all-or-nothing: one row that doesn't
	// fit the schema (e.g. "Patch Install" sent with no decorationType and no OTHER type,
	// which happened for real on Job 100113 before OTHER existed) should lose that one
	// line item, with a flag saying so, not the whole order.
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
		// Include why line items were dropped — otherwise the bare zod error gives no hint
		// that some rows were already thrown out before this final check.
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
