/**
 * How many colors a decoration's "Color(s)" text lists — e.g. "White thread" → 1,
 * "109c Yellow, White" → 2. Null when the text doesn't name real colors ("TBD",
 * "Multi", blank), so the caller decides what to assume instead of this guessing.
 */
const NOT_A_COLOR = /^(tbd|tba|multi|multiple|multicolou?r|full colou?r|n\/?a|none|\?+)$/i;

export function countDecorationColors(text: string | null | undefined): number | null {
	if (!text) return null;
	const entries = text
		.split(/,|;|\/|&|\+|\band\b/i)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0 || entries.some((entry) => NOT_A_COLOR.test(entry))) return null;
	return entries.length;
}
