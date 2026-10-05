/**
 * How many colors a decoration's "Color(s)" text lists — e.g. "White thread" → 1,
 * "109c Yellow, White" → 2. Null when the text doesn't name real colors ("TBD",
 * "Multi", blank), so the caller decides what to assume instead of this guessing.
 * Used by estimateHours.ts' colorCountFor() as the fallback when a line item has no
 * stored inkColorCount (2026-10-02: assume what the PDF says instead of asking).
 */

// Placeholder words that mean "the colors aren't decided" — if any entry is one of
// these, the whole text is treated as not countable.
const NOT_A_COLOR = /^(tbd|tba|multi|multiple|multicolou?r|full colou?r|n\/?a|none|\?+)$/i;

/**
 * Counts the colors in a "Color(s)" string by splitting on `,` `;` `/` `&` `+` and the
 * word "and".
 * @returns the number of colors, or null for blank text or any placeholder entry.
 */
export function countDecorationColors(text: string | null | undefined): number | null {
	if (!text) return null;
	const entries = text
		.split(/,|;|\/|&|\+|\band\b/i)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0 || entries.some((entry) => NOT_A_COLOR.test(entry))) return null;
	return entries.length;
}
