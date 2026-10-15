import { env } from '$env/dynamic/private';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { isPressKind } from '$lib/schedule/stationKinds';
import { pinWorker, StaffingError } from '$lib/server/schedule/staffing';

/**
 * Settings → People notes → suggested staffing rules (2026-10-14). The team writes
 * plain notes on a person ("Nick runs the autos as main", "Ana is out Oct 20–24",
 * "put Bo on fold & bag Friday"); Claude reads the note and suggests the structured
 * settings it maps to. An admin ticks the ones that are right and applies them; only
 * then does anything change, and the deterministic staffing planner (planStaffing.ts)
 * reads those settings like any other — Claude never places people itself.
 *
 * Only rules the system can actually hold are suggested: certify / uncertify on a
 * station, main printer on a press, days out, and a one-day pin to a station. Anything
 * else in the note (part-day shifts, preferences, "usually") is listed back as "not
 * turned into a rule" so nobody assumes the schedule knows it.
 *
 * Same pattern as the order page's notes box (hoops/fillNeedsAttentionFromNotes.ts).
 */

const MODEL = 'claude-sonnet-5';
// Longest days-out range one rule may cover (same cap as set_worker_availability).
const MAX_OUT_DAYS = 62;

/** An expected failure (no notes, no API key, API problem); its message is shown to the admin as-is. */
export class WorkerNoteRulesError extends Error {}

const isoDate = z.iso.date();

/** One rule an admin can apply. Re-validated on apply — the browser sends it back.
 *  set_main / set_operator (2026-10-15) set the worker-level flag; they don't take a
 *  stationId because main/operator are now general properties, not per-press. */
export const workerRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('certify'), stationId: z.string().min(1) }),
	z.object({ kind: z.literal('uncertify'), stationId: z.string().min(1) }),
	z.object({ kind: z.literal('set_main'), isMain: z.boolean() }),
	z.object({ kind: z.literal('set_operator'), isOperator: z.boolean() }),
	z.object({ kind: z.literal('out'), from: isoDate, to: isoDate, reason: z.string().trim().max(200).nullable().optional() }),
	z.object({ kind: z.literal('pin'), date: isoDate, stationId: z.string().min(1) })
]);
export type WorkerRule = z.infer<typeof workerRuleSchema>;

export interface SuggestedRule {
	rule: WorkerRule;
	/** Plain sentence for the checkbox, e.g. "Main printer on Auto Press 1". */
	label: string;
	/** The part of the note it came from. */
	quote: string;
}

export interface WorkerRuleSuggestions {
	workerId: string;
	workerName: string;
	rules: SuggestedRule[];
	/** Parts of the note that can't be a rule, with why. */
	notRules: { quote: string; why: string }[];
}

const suggestTool: Anthropic.Tool = {
	name: 'suggest_rules',
	description: "Emit the staffing rules a person's note clearly states, and the parts of the note that can't be one of those rules.",
	input_schema: {
		type: 'object',
		properties: {
			rules: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						kind: { type: 'string', enum: ['certify', 'uncertify', 'set_main', 'set_operator', 'out', 'pin'] },
						station: { type: 'string', description: 'Exact station name from the list given (certify, uncertify, pin).' },
						isMain: { type: 'boolean', description: 'set_main: true = this person may run any press they are certified on as the main printer; false = clear the main flag.' },
						isOperator: { type: 'boolean', description: 'set_operator: true = this person may run any press they are certified on as an operator (fallback lead below main); false = clear the operator flag.' },
						from: { type: 'string', description: 'out: first day out, YYYY-MM-DD.' },
						to: { type: 'string', description: 'out: last day out, YYYY-MM-DD (same as from for one day).' },
						reason: { type: 'string', description: 'out: short reason if the note gives one.' },
						date: { type: 'string', description: 'pin: the day, YYYY-MM-DD.' },
						quote: { type: 'string', description: 'The words from the note this rule comes from.' }
					},
					required: ['kind', 'quote']
				}
			},
			notRules: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						quote: { type: 'string' },
						why: { type: 'string', description: 'One short sentence: why this cannot be one of the rule kinds.' }
					},
					required: ['quote', 'why']
				}
			}
		},
		required: ['rules', 'notRules']
	}
};

const SYSTEM_PROMPT = `You turn a print shop's notes about one floor worker into structured staffing settings that a person will review before anything is applied.
The only settings that exist:
- certify / uncertify: the person can (or can no longer) work a station.
- set_main: a worker-level flag — true means they may run any press they're certified on as the main printer; false clears the flag. (Not per-press.) Every press needs a lead to run.
- set_operator: a worker-level flag — true means they may run any press they're certified on as an operator (a fallback lead below main); false clears the flag.
- out: whole days they are not working, as a from–to date range.
- pin: put them on one station for one specific day.
Rules:
- Only emit a rule the note clearly states. Never guess, infer from a job title, or add a default.
- Use exact station names from the list. Use dates as YYYY-MM-DD, resolving words like "Friday" or "next week" against today's date given below; if a date is ambiguous, don't emit the rule — list it under notRules.
- Recurring patterns ("every Friday", "only mornings"), part days, preferences and anything else go under notRules with a short reason. Don't emit a rule that's already true (current settings are given).
Call suggest_rules exactly once.`;

function isRealDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The model sometimes sends an array field as a JSON string — even the whole
 *  { rules, notRules } object inside `rules`. Unwrap either shape; anything else is
 *  left for the checks below to drop. */
function normalizeToolInput(input: unknown): Record<string, unknown> {
	let result = (input && typeof input === 'object' ? { ...input } : {}) as Record<string, unknown>;
	for (const key of ['rules', 'notRules']) {
		const value = result[key];
		if (typeof value !== 'string') continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) result[key] = parsed;
			else if (parsed && typeof parsed === 'object') result = { ...result, ...(parsed as Record<string, unknown>) };
		} catch {
			result[key] = [];
		}
	}
	for (const key of ['rules', 'notRules']) if (!Array.isArray(result[key])) result[key] = [];
	return result;
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Asks Claude what rules this person's saved notes state. Changes nothing.
 *
 * @throws WorkerNoteRulesError for a missing person, empty notes, a missing API key or
 *   an unusable response
 */
export async function suggestRulesFromNotes(workerId: string): Promise<WorkerRuleSuggestions> {
	const worker = await prisma.worker.findFirst({
		where: { id: workerId, archivedAt: null },
		select: { id: true, name: true, notes: true, isMain: true, isOperator: true, certifications: { where: { station: { archivedAt: null } }, select: { stationId: true } } }
	});
	if (!worker) throw new WorkerNoteRulesError('Person not found.');
	if (!worker.notes?.trim()) throw new WorkerNoteRulesError(`${worker.name} has no notes to read.`);
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new WorkerNoteRulesError('ANTHROPIC_API_KEY is required to read notes into rules.');

	const stations = await prisma.station.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], select: { id: true, label: true, kind: true } });
	const byLabel = new Map(stations.map((s) => [s.label.toLowerCase(), s]));
	const certified = new Set(worker.certifications.map((c) => c.stationId));
	const pressRole = worker.isMain ? 'main' : worker.isOperator ? 'operator' : 'catch';
	const today = new Date().toISOString().slice(0, 10);

	const current = stations
		.filter((s) => certified.has(s.id))
		.map((s) => s.label);
	const context = [
		`Today: ${today} (${new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })})`,
		`Person: ${worker.name}`,
		`Press role: ${pressRole} (main > operator > catch; main and operator apply to every press they're certified on)`,
		`Stations: ${stations.map((s) => `${s.label}${isPressKind(s.kind) ? ' [screen-print press]' : ''}`).join(', ') || '(none)'}`,
		`Currently certified on: ${current.join(', ') || '(nothing)'}`,
		'',
		'Note:',
		worker.notes
	].join('\n');

	let response;
	try {
		response = await new Anthropic({ apiKey }).messages.create({
			model: MODEL,
			max_tokens: 4096,
			system: SYSTEM_PROMPT,
			tools: [suggestTool],
			tool_choice: { type: 'tool', name: suggestTool.name },
			messages: [{ role: 'user', content: context }]
		});
	} catch (err) {
		throw new WorkerNoteRulesError(`Couldn't reach Claude to read the notes: ${err instanceof Error ? err.message : String(err)}`);
	}
	const toolUse = response.content.find((block) => block.type === 'tool_use');
	if (!toolUse || toolUse.type !== 'tool_use') throw new WorkerNoteRulesError('Claude didn’t return any rules — try again.');
	const raw = normalizeToolInput(toolUse.input) as {
		rules?: { kind?: string; station?: string; isMain?: boolean; isOperator?: boolean; from?: string; to?: string; reason?: string; date?: string; quote?: string }[];
		notRules?: { quote?: string; why?: string }[];
	};

	// Everything Claude sent is checked against real stations, real dates and the
	// person's current settings; anything that doesn't hold up is shown as not-a-rule.
	const rules: SuggestedRule[] = [];
	const notRules = (raw.notRules ?? []).filter((n) => n.quote && n.why).map((n) => ({ quote: n.quote!, why: n.why! }));
	const reject = (quote: string | undefined, why: string) => notRules.push({ quote: quote ?? '(part of the note)', why });

	for (const r of raw.rules ?? []) {
		const quote = r.quote ?? '';
		const station = r.station ? byLabel.get(r.station.toLowerCase()) : undefined;
		if (r.kind === 'certify' || r.kind === 'uncertify' || r.kind === 'pin') {
			if (!station) {
				reject(quote, `No station called "${r.station ?? ''}".`);
				continue;
			}
		}
		if (r.kind === 'certify' && station) {
			if (certified.has(station.id)) continue; // already true
			rules.push({ rule: { kind: 'certify', stationId: station.id }, label: `Certify on ${station.label}`, quote });
		} else if (r.kind === 'uncertify' && station) {
			if (!certified.has(station.id)) continue;
			rules.push({ rule: { kind: 'uncertify', stationId: station.id }, label: `No longer certified on ${station.label}`, quote });
		} else if (r.kind === 'set_main') {
			const isMain = r.isMain !== false;
			if (worker.isMain === isMain) continue;
			rules.push({ rule: { kind: 'set_main', isMain }, label: isMain ? 'Main printer (any press they are certified on)' : 'No longer a main printer', quote });
		} else if (r.kind === 'set_operator') {
			const isOperator = r.isOperator !== false;
			if (worker.isOperator === isOperator) continue;
			rules.push({ rule: { kind: 'set_operator', isOperator }, label: isOperator ? 'Operator (fallback press lead)' : 'No longer an operator', quote });
		} else if (r.kind === 'out') {
			const to = r.to ?? r.from;
			if (!isRealDate(r.from) || !isRealDate(to) || to < r.from || daysBetween(r.from, to) > MAX_OUT_DAYS) {
				reject(quote, 'The dates weren’t clear enough to mark days out.');
				continue;
			}
			if (to < today) continue; // already past
			const reason = r.reason?.trim().slice(0, 200) || null;
			rules.push({ rule: { kind: 'out', from: r.from, to, reason }, label: `Out ${r.from === to ? r.from : `${r.from} to ${to}`}${reason ? ` (${reason})` : ''}`, quote });
		} else if (r.kind === 'pin' && station) {
			if (!isRealDate(r.date) || r.date < today) {
				reject(quote, 'The day wasn’t clear (or has passed).');
				continue;
			}
			rules.push({ rule: { kind: 'pin', date: r.date, stationId: station.id }, label: `On ${station.label} on ${r.date}${certified.has(station.id) ? '' : ' (certifies them too)'}`, quote });
		}
	}
	// Drop exact duplicates.
	const seen = new Set<string>();
	const unique = rules.filter((r) => {
		const key = JSON.stringify(r.rule);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { workerId: worker.id, workerName: worker.name, rules: unique, notRules };
}

/**
 * Applies the rules an admin ticked. Each one is re-validated here (the browser sent
 * them back) and applied in one transaction with an audit entry.
 *
 * @returns how many rules were applied
 * @throws WorkerNoteRulesError for a bad rule, an unknown person/station, or a pin the
 *   staffing rules refuse (e.g. they're marked out that day)
 */
export async function applyWorkerRules(workerId: string, rawRules: unknown[], actor: string): Promise<number> {
	const parsed = z.array(workerRuleSchema).max(50).safeParse(rawRules);
	if (!parsed.success) throw new WorkerNoteRulesError('Those suggestions are out of date — read the notes again.');
	const rules = parsed.data;
	if (rules.length === 0) throw new WorkerNoteRulesError('Tick at least one suggestion to apply.');

	try {
		await prisma.$transaction(async (tx) => {
			const worker = await tx.worker.findFirst({ where: { id: workerId, archivedAt: null }, select: { id: true, name: true } });
			if (!worker) throw new WorkerNoteRulesError('Person not found.');
			const stationIds = [...new Set(rules.flatMap((r) => ('stationId' in r ? [r.stationId] : [])))];
			const stations = new Map((await tx.station.findMany({ where: { id: { in: stationIds }, archivedAt: null }, select: { id: true, kind: true } })).map((s) => [s.id, s]));
			if (stations.size !== stationIds.length) throw new WorkerNoteRulesError('One of those stations no longer exists — read the notes again.');

			const certify = (stationId: string) =>
				tx.workerCertification.upsert({
					where: { workerId_stationId: { workerId, stationId } },
					create: { workerId, stationId },
					update: {}
				});

			for (const rule of rules) {
				if (rule.kind === 'certify') await certify(rule.stationId);
				else if (rule.kind === 'uncertify') await tx.workerCertification.deleteMany({ where: { workerId, stationId: rule.stationId } });
				else if (rule.kind === 'set_main') {
					// Main wins over operator (planStaffing never looks at operator on a main),
					// so clear operator when a worker becomes a main — keeps the stored flag clean.
					await tx.worker.update({ where: { id: workerId }, data: { isMain: rule.isMain, ...(rule.isMain ? { isOperator: false } : {}) } });
				} else if (rule.kind === 'set_operator') {
					await tx.worker.update({ where: { id: workerId }, data: { isOperator: rule.isOperator, ...(rule.isOperator ? { isMain: false } : {}) } });
				} else if (rule.kind === 'out') {
					if (rule.to < rule.from || daysBetween(rule.from, rule.to) > MAX_OUT_DAYS) throw new WorkerNoteRulesError('A days-out range is too long or backwards.');
					for (let d = new Date(`${rule.from}T00:00:00Z`); d <= new Date(`${rule.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
						const date = new Date(d);
						await tx.workerUnavailability.upsert({
							where: { workerId_date: { workerId, date } },
							create: { workerId, date, reason: rule.reason ?? null, createdBy: actor },
							update: { reason: rule.reason ?? null, createdBy: actor }
						});
						await tx.staffingPin.deleteMany({ where: { workerId, date } });
					}
				} else if (rule.kind === 'pin') {
					await certify(rule.stationId);
					await pinWorker(tx, { workerId, date: rule.date, stationId: rule.stationId }, actor);
				}
				// (The never-reached fall-through branch catches unexpected kinds at compile time.)
			}
			await tx.domainAuditLog.create({
				data: { entity: 'Worker', entityId: workerId, action: 'worker_rules_applied_from_notes', actor, diff: { name: worker.name, rules } }
			});
		});
	} catch (err) {
		if (err instanceof StaffingError) throw new WorkerNoteRulesError(err.message);
		throw err;
	}
	return rules.length;
}
