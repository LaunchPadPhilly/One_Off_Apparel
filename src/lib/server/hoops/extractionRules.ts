/**
 * How to read a Hoops "Job" PDF into order data — the one copy of these rules (2026-10-05).
 * Two readers use it so they give the same result:
 *   - extractOrderFromPdf.ts, when someone uploads a PDF on the Orders page (the app
 *     sends the PDF and these rules to the Claude API itself);
 *   - the `import_hoops_export` MCP tool's description, when someone drops a PDF into
 *     Claude chat and chat Claude reads it.
 * This text is sent to Claude as instructions, so its wording is behavior: re-test an
 * import after changing it. Kept free of `$env` so the standalone MCP server can load it.
 */
export const HOOPS_EXTRACTION_RULES = `- The "Job <number>" line is the order identifier.
- The job details table is organized into repeating groups: one blank/garment block (Code, Name/Description, Vendor, Color, Size, Quantity rows — one row per size) followed by one or more decoration/finishing rows (Name/Description, Vendor, Position, Color(s), Size, Quantity). Each decoration or finishing row is its own line item, sharing the same order — NOT one line item per garment/size row.
- A matte finishing row depends on the decoration it finishes within the same garment group — wire dependsOn to that decoration's localId. Fold & bag always waits on everything ("all_siblings"). Relabel, hang tags and wovens wait on nothing — leave their dependsOn null. (The system enforces these rules itself; this just keeps your output consistent with them.)
- Never invent a value you cannot support from the text. When something doesn't fit the schema (an unmapped treatment type, a missing signal, an ambiguous position), say so in confidenceFlags rather than guessing silently. This system's whole design assumes a human reviews everything you extract before it becomes real — your job is to make what you're unsure about visible, not to be right about everything.
- If a treatment is real production work but has no matching decorationType or finishingStep (e.g. "Patch Install" — it's neither screen print/embroidery/DTF/DTG nor matte/relabel/fold&bag/hang tag/wovens), include it as itemType "OTHER" with otherJobType set to its name as written (e.g. "Patch Install"), decorationType and finishingStep null, and note it in confidenceFlags. Never force it into a type it isn't; a reviewer will assign its station and hours.
- Rows that aren't production work on garments — administrative fees (digitizing fee, ink color change) and supply/material lines (e.g. "75 units of patches", leftover patches for the customer) — are never line items. Leave them out and mention them in confidenceFlags.
- Every DECORATION row gets a garmentStyle, read from its garment block's product name/description: a cap or hat (snapback, trucker, dad hat, visor, beanie) is CAP; anything else — a shirt, tee, polo, hoodie, crewneck, jacket, bag — is FLAT. Never leave it null on a decoration.
- If there is no "Deadline", return an empty deadline and say so in confidenceFlags. Never use another date instead.`;
