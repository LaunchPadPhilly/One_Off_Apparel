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
			externalShipDate: { type: 'string', description: 'ISO date YYYY-MM-DD. Use the "Deadline" date.' },
			internalDueDate: { type: 'string', description: 'ISO date YYYY-MM-DD. Same as externalShipDate — the export gives only one date; always flag this in confidenceFlags.' },
			confidenceFlags: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Free-text notes on anything uncertain or excluded: unmapped decoration/finishing types (e.g. "Patch Install" has no schema match), administrative fee rows excluded (e.g. digitizing fee, ink color change), missing weight_class signal, print_location that did not fit front/back/left/right, or the single-date assumption above. Always include at least the single-date note.'
			},
			lineItems: {
				type: 'array',
				description:
					'One entry per decoration or finishing treatment — NOT per garment/blank row. A garment with two prints is two line items. Administrative fee rows (digitizing fee, ink color change, etc.) are never line items — exclude them and note it in confidenceFlags instead.',
				items: {
					type: 'object',
					properties: {
						localId: { type: 'string', description: 'Any unique string within this order, e.g. "1", "2" — used to wire dependsOn before real ids exist.' },
						itemType: { type: 'string', enum: ['DECORATION', 'FINISHING'] },
						design: { type: 'string', description: 'What the design is, including any design code shown (e.g. "HooDoo stacked script logo (AA2965)").' },
						printLocation: {
							type: ['string', 'null'],
							enum: ['FRONT', 'BACK', 'LEFT', 'RIGHT', null],
							description: 'Only if the export\'s position clearly maps to one of these four. "Right of Back Seam", "Sleeve/Collar" etc. do not — use null and note the raw position text in confidenceFlags instead of guessing.'
						},
						decorationType: { type: ['string', 'null'], enum: ['SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG', null], description: 'DECORATION rows only, else null.' },
						finishingStep: { type: ['string', 'null'], enum: ['MATTE', 'RELABEL', 'FOLD_BAG', 'HANG_TAG', null], description: 'FINISHING rows only, else null.' },
						dependsOn: {
							type: ['string', 'null'],
							description:
								'FINISHING rows only. Another line item\'s localId (the specific decoration this finish applies to), or the literal string "all_siblings" if it depends on every other line item on the order (e.g. final packaging). Null for DECORATION rows.'
						},
						weightClass: {
							type: 'string',
							enum: ['THIN', 'POLY', 'BULKY'],
							description:
								'From an inline hint like "(Thin - ...)" or "(Fleece/Bulky)" when present. If the product has no such hint (e.g. headwear), there is no correct value yet — default to "THIN" and you MUST add a confidenceFlags entry naming this line item and saying no weight-class signal existed.'
						},
						apparelColor: { type: 'string' },
						inkColorCount: { type: ['integer', 'null'], description: 'From "N Color Screen Print" or similar. Null if not applicable.' },
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
		required: ['hoopsOrderId', 'customerName', 'externalShipDate', 'internalDueDate', 'lineItems']
	}
};

const SYSTEM_PROMPT = `You extract structured order data from a "Job" PDF exported from Hoops, a shop-management tool this apparel decorator uses. Each PDF describes exactly one job/order. Read it carefully:

- The "Job <number>" line is the order identifier.
- The job details table is organized into repeating groups: one blank/garment block (Code, Name/Description, Vendor, Color, Size, Quantity rows — one row per size) followed by one or more decoration/finishing rows (Name/Description, Vendor, Position, Color(s), Size, Quantity). Each decoration or finishing row is its own line item, sharing the same order — NOT one line item per garment/size row.
- A finishing row (relabel, matte, etc.) depends on the decoration it finishes within the same garment group — wire dependsOn to that decoration's localId.
- Never invent a value you cannot support from the text. When something doesn't fit the schema (an unmapped treatment type, a missing signal, an ambiguous position), say so in confidenceFlags rather than guessing silently. This system's whole design assumes a human reviews everything you extract before it becomes real — your job is to make what you're unsure about visible, not to be right about everything.
- If a treatment has no matching decorationType or finishingStep at all (e.g. "Patch Install" — it's neither screen print/embroidery/DTF/DTG nor matte/relabel/fold&bag/hang tag), DO NOT put it in lineItems, not even with a null/guessed type. Leave it out of the array entirely and describe it in confidenceFlags instead — an item with no schema mapping is not a line item with missing fields, it's an excluded item.

Call emit_extracted_order exactly once with everything you found.`;

export async function extractOrderFromPdf(pdfBase64: string, filename: string): Promise<OrderCandidate & { confidenceFlags: string[] }> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new PdfExtractionError('ANTHROPIC_API_KEY is required for PDF import extraction');

	const client = new Anthropic({ apiKey });

	let response;
	try {
		response = await client.messages.create({
			model: MODEL,
			max_tokens: 4096,
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

	try {
		const validated = orderCandidateSchema.parse({ ...raw, importedBy, lineItems });
		return { ...validated, confidenceFlags };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new PdfExtractionError(`"${filename}" extracted but failed schema validation even after dropping bad line items: ${detail}`, error);
	}
}
