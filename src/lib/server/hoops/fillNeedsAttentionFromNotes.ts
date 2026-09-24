import { env } from '$env/dynamic/private';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '$lib/server/prisma';
import { computeOrderGaps, type OrderGapQuestion } from './orderGaps';
import { updateOrderFields, updateLineItemFields } from './updateOrderFields';
import type { OrderCorrection, LineItemCorrection } from './types';

/**
 * The order review page's "answer these to fill in what's needed" notes box. A reviewer
 * writes one free-text note answering some or all of the order's outstanding questions
 * (computeOrderGaps' `questions` — the ones with a real, settable field behind them,
 * never the merely-informational ones); Claude reads the note against that exact
 * question list and returns only the fields the note actually answers, which get applied
 * through the SAME validated update functions the per-field edit forms already use
 * (updateOrderFields / updateLineItemFields) — so this is just a faster way to fill in
 * those forms, not a second write path, and it changes nothing about CLAUDE.md's human
 * approval gates: the order is still NEEDS_REVIEW afterward, "Confirm import" is still a
 * separate, explicit click, and every field this touches stays directly editable by hand
 * afterward too.
 *
 * Per CLAUDE.md's non-negotiable design principles, Claude is never trusted to guess an
 * unaddressed field — the tool is instructed to omit anything the note doesn't actually
 * answer, and this module double-checks that whatever comes back is one of the field's
 * real allowed values before writing anything.
 */

const MODEL = 'claude-sonnet-5';

export class FillFromNotesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FillFromNotesError';
	}
}

type FieldKind = readonly string[] | 'integer' | 'hours';

const ALLOWED_VALUES: Record<string, FieldKind> = {
	blankOrderingStatus: ['NOT_ORDERED', 'ORDERED', 'ISSUE', 'RECEIVED'],
	customerApprovalStatus: ['NOT_SENT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED'],
	artworkApprovalStatus: ['NOT_SUBMITTED', 'PENDING_APPROVAL', 'REVISION_REQUESTED', 'APPROVED'],
	garmentStyle: ['FLAT', 'CAP'],
	capConstruction: ['STRUCTURED', 'UNSTRUCTURED'],
	matteSurface: ['FLAT', 'SPECIALTY'],
	foldBagGarment: ['SS_TEE', 'OTHER'],
	inkColorCount: 'integer',
	stitchCount: 'integer',
	manualEstimatedHours: 'hours'
};

function describeAllowedValues(kind: FieldKind): string {
	if (kind === 'integer') return 'a whole number';
	if (kind === 'hours') return 'a number of hours greater than 0, decimals allowed (e.g. 1.5)';
	return kind.join(', ');
}

const answersTool: Anthropic.Tool = {
	name: 'emit_answers',
	description: 'Emit an answer for every outstanding question the reviewer\'s note actually addresses.',
	input_schema: {
		type: 'object',
		properties: {
			answers: {
				type: 'array',
				description:
					'One entry per question the note answers. Omit a question entirely if the note does not address it — never guess, infer, or supply a default for an unaddressed question.',
				items: {
					type: 'object',
					properties: {
						questionKey: { type: 'string', description: 'The exact key of the question being answered, copied from the list given.' },
						value: { type: 'string', description: "The answer, as one of that question's exact allowed values (or a whole number, for a numeric question)." }
					},
					required: ['questionKey', 'value']
				}
			}
		},
		required: ['answers']
	}
};

const SYSTEM_PROMPT = `You help a shop reviewer quickly resolve specific outstanding gaps on an apparel order, from their own plain-language note.

You are given a numbered list of questions. Each has a key and its exact allowed answer values. Read the reviewer's note and, for each question it actually answers, call emit_answers with that question's key and the matching allowed value. A question the note doesn't address must simply be left out of the answers array — do not guess, infer, or default it, and never invent a key that wasn't given. Call emit_answers exactly once.`;

export interface FillFromNotesResult {
	answeredCount: number;
	unansweredCount: number;
}

export async function fillNeedsAttentionFromNotes(orderId: string, note: string, actor: string): Promise<FillFromNotesResult> {
	if (!note.trim()) throw new FillFromNotesError('Write a note answering one or more of the questions above first.');

	const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lineItems: true } });
	if (!order) throw new FillFromNotesError(`Order ${orderId} not found`);

	const lastImportLog = await prisma.domainAuditLog.findFirst({
		where: { entity: 'Order', entityId: orderId, action: { in: ['hoops_import_created', 'hoops_import_reopened'] } },
		orderBy: { at: 'desc' }
	});
	const importFlags = ((lastImportLog?.diff as { confidenceFlags?: string[] } | null)?.confidenceFlags ?? []) as string[];

	const { questions } = computeOrderGaps({ ...order, importFlags }, order.lineItems);
	if (questions.length === 0) throw new FillFromNotesError('Nothing outstanding to answer on this order.');

	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new FillFromNotesError('ANTHROPIC_API_KEY is required to answer questions from notes.');

	const client = new Anthropic({ apiKey });
	const questionList = questions
		.map((q, i) => `${i + 1}. key="${q.key}" — ${q.question} Allowed values: ${describeAllowedValues(ALLOWED_VALUES[q.target.field])}.`)
		.join('\n');

	let response;
	try {
		response = await client.messages.create({
			model: MODEL,
			max_tokens: 8192,
			system: SYSTEM_PROMPT,
			tools: [answersTool],
			tool_choice: { type: 'tool', name: answersTool.name },
			messages: [{ role: 'user', content: `Outstanding questions:\n${questionList}\n\nReviewer's note:\n${note}` }]
		});
	} catch (err) {
		throw new FillFromNotesError(`Claude API call failed while answering questions from notes: ${err instanceof Error ? err.message : String(err)}`);
	}

	// A large order can mean a large question list, which means a large answers array —
	// `max_tokens` above is generous, but if Claude still gets cut off mid-generation,
	// the tool call is incomplete; better to say so plainly than to silently apply a
	// partial (or empty) set of answers as if it were the model's full response.
	if (response.stop_reason === 'max_tokens') {
		throw new FillFromNotesError('Claude ran out of room answering this many questions at once — try a shorter note, or answer fewer questions per note.');
	}

	const toolUse = response.content.find((block) => block.type === 'tool_use');
	if (!toolUse || toolUse.type !== 'tool_use') {
		throw new FillFromNotesError(`Claude did not return structured answers (stop_reason: ${response.stop_reason})`);
	}

	const rawAnswers = (toolUse.input as { answers?: { questionKey: string; value: string }[] }).answers ?? [];
	const questionsByKey = new Map(questions.map((q) => [q.key, q] as const));

	const orderPatch: Partial<OrderCorrection> = {};
	const lineItemPatches = new Map<string, Partial<LineItemCorrection>>();
	let unansweredCount = questions.length;

	for (const answer of rawAnswers) {
		const question = questionsByKey.get(answer.questionKey);
		if (!question) continue; // Claude named a key that wasn't in the list — ignore rather than guess what it meant.

		const allowed = ALLOWED_VALUES[question.target.field];
		const isValid =
			allowed === 'integer'
				? Number.isInteger(Number(answer.value))
				: allowed === 'hours'
					? Number.isFinite(Number(answer.value)) && Number(answer.value) > 0
					: allowed.includes(answer.value);
		if (!isValid) continue; // Not one of the field's real values — drop it rather than write something invalid.

		unansweredCount -= 1;
		const value: string | number = allowed === 'integer' || allowed === 'hours' ? Number(answer.value) : answer.value;

		if (question.target.level === 'order') {
			(orderPatch as Record<string, string | number>)[question.target.field] = value;
		} else {
			const patch = lineItemPatches.get(question.target.lineItemId) ?? {};
			(patch as Record<string, string | number>)[question.target.field] = value;
			lineItemPatches.set(question.target.lineItemId, patch);
		}
	}

	if (Object.keys(orderPatch).length > 0) await updateOrderFields(orderId, orderPatch, actor);
	for (const [lineItemId, patch] of lineItemPatches) {
		await updateLineItemFields(lineItemId, patch, actor);
	}

	await prisma.domainAuditLog.create({
		data: {
			entity: 'Order',
			entityId: orderId,
			action: 'needs_attention_filled_from_notes',
			actor,
			diff: { note, orderPatch, lineItemPatches: Object.fromEntries(lineItemPatches) }
		}
	});

	return { answeredCount: questions.length - unansweredCount, unansweredCount };
}

// Re-exported for the order page to describe, per question, what it can and can't answer
// via the notes box (a question's target field name isn't otherwise client-visible).
export type { OrderGapQuestion };
