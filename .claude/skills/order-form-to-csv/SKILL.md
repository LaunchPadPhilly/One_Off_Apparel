# Order Form → CSV

Extract structured data from One Off Apparel order forms into a single `line_items.csv` ready for direct upload to the Orders page at `/orders`. This CSV is the bridge between Hoops order forms and the scheduling system's import flow.

## Workflow

1. **Read** each order form provided (PDF, image, or pasted text).
2. **Extract** into the schema defined below.
3. **Check for existing CSV** — if the user uploaded an existing `line_items.csv`, read it and append. Otherwise create a fresh file.
4. **Deduplicate** — if a `job_number` already exists, ask the user before overwriting or skipping (see *Duplicate handling*).
5. **Write** the CSV.
6. **Report** what was added with row counts.

## Why a single CSV

The scheduling system's `/orders` import page groups rows by `job_number` to create orders. Order-level fields (`customer_name`, dates) are denormalized — repeated on every row sharing a `job_number`. This avoids multi-file joins and lets the user upload one file to get orders with estimates.

## Schema — `line_items.csv`

One row per decoration or finishing line on the form. Type-specific fields are nullable — leave blank when not applicable.

| Column | Type | Required | Notes |
|---|---|---|---|
| `line_item_id` | string | yes | `{job_number}-{NN}` where NN is 1-based order on the form. |
| `job_number` | string | yes | Groups rows into orders. From top-right of form. |
| `customer_name` | string | yes | Repeat on every row sharing the same `job_number`. |
| `external_ship_date` | ISO date | yes | `YYYY-MM-DD`. The customer-promised ship date. Parse from `Deadline:` field. |
| `internal_due_date` | ISO date | yes | `YYYY-MM-DD`. Production target — typically 2–3 business days before `external_ship_date`. If not explicitly on the form, subtract 3 calendar days from `external_ship_date`. |
| `item_type` | enum | yes | See *Item type classification*. |
| `position` | string | | e.g. `Front LC`, `Back`. Blank for finishing/shipping/discount. |
| `name_description` | string | yes | Raw text of the line — preserves anything not captured by structured fields. |
| `colors` | string | | Ink/thread color(s), e.g. `orange/white`, `White thread`. This is the decoration color, NOT the garment color. |
| `apparel_color` | string | | Garment color, e.g. `Black`, `Heather Grey`. Parse from the garment/style section of the form if available. |
| `size` | string | | Print/embroidery dimension, e.g. `12"W`, `3.5"W`. |
| `quantity` | integer | yes | Total units for this line. |
| `color_count` | integer | | Number of ink/thread colors. Parse from name — "2 Color Screen Print" → `2`. For embroidery, count distinct thread colors. |
| `screens` | integer | | **Screen print only.** Number of screens. Often equals `color_count` unless noted otherwise on the form. If not explicitly stated, default to `color_count`. |
| `weight_class` | enum | | `thin`, `poly`, or `bulky`. Parse from garment info where possible (standard tees = `thin`, polyester/performance = `poly`, hoodies/fleece = `bulky`). See *Weight class inference*. |
| `stitch_count` | integer | | **Embroidery only.** Parse from name — "5,000 Stitches" → `5000`. |
| `thread_count` | integer | | **Embroidery only.** Distinct thread colors used. Default `1` if only one color listed. |
| `matte_surface` | enum | | **Matte finish only.** `flat` or `specialty` — selects the matte formula. Leave blank if the form doesn't say. |
| `fold_bag_garment` | enum | | **Fold & bag only.** `ss_tee` for short-sleeve tees, `other` for anything else. Leave blank if unclear. |

## Item type classification

Map each line item to `item_type` from cues in the name:

| Cue in `name_description` | `item_type` |
|---|---|
| "Screen Print" | `screen_print` |
| "Embroidery" | `embroidery` |
| "DTF" | `dtf` |
| "DTG" | `dtg` |
| "Woven Label" | `woven_label` |
| "Printed Relabel" or "Relabel" | `printed_relabel` |
| "Matte Finish" | `matte_finish` |
| "Hang Tag" | `hang_tags` |
| "Fold" and "Bag" | `fold_bag` |
| Exactly "Shipping" | `shipping` |
| Exactly "Discount" | `discount` |
| Anything else | `other` |

For `other` items, still capture `name_description` and `quantity` — they surface for user review.

## Weight class inference

The estimation engine needs `weight_class` (thin/poly/bulky) to select the correct rate table. If the form doesn't state it explicitly, infer from the garment:

| Garment cue | `weight_class` |
|---|---|
| Standard cotton tee, tri-blend tee, tank top | `thin` |
| Polyester, performance, moisture-wicking | `poly` |
| Hoodie, sweatshirt, fleece, jacket, heavyweight | `bulky` |
| Unknown or ambiguous | leave blank — the import page defaults to `thin` with a warning |

## Duplicate handling

Before writing, check whether `job_number` already exists in the CSV:

- **Not present** → append rows.
- **Already present** → do not silently overwrite. Ask the user: skip this job, replace all rows for this job, or append as a new entry.

## Output

Write to the working directory as `line_items.csv`. If in a chat environment, write to `/mnt/user-data/outputs/` and present the file.

## Report format

After writing:

```
Processed [N] order form(s).

line_items.csv: +[X] row(s) (total: [Y])

Jobs: [list of job_numbers with customer names]
Duplicates handled: [none | list]
Unclassified lines (item_type=other): [none | list]
Missing fields: [list of columns left blank and why]
```

Flag any `other` items and any rows missing `weight_class` or `screens` — those affect estimate accuracy.
