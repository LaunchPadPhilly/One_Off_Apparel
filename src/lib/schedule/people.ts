/**
 * Small display helpers for the shop-floor roster (People panel and job hover on the
 * draft board, 2026-10-14). Floor staff have no photos or logins, so a person's
 * "profile icon" is their initials on a color picked deterministically from their id —
 * the same person is the same color everywhere, on every load.
 */

/** "Mitch Alvarez" → "MA", "jose" → "JO". */
export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable hue (0–359) for a person's avatar. */
export function avatarHue(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	return hash % 360;
}

/** What someone does on a job: the press's main printer, a catch, or plain crew off-press. */
export type CrewRole = 'main' | 'catch' | 'crew';

export function crewRoleLabel(role: CrewRole): string {
	return role === 'main' ? 'Main' : role === 'catch' ? 'Catch' : 'Crew';
}
