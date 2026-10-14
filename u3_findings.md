# U3 spike: is the target mapping available at import time? (task 77)

Branch `di-server-errors`, follows U1 (`5b31f98396`). Checked by reading the source and by Jest
unit tests only. I did not touch the live cluster.

## Verdict: yes, in both modes

| Mode | Where the target mapping comes from | Already in scope? |
|---|---|---|
| `createMode=true` (new index) | Request body `mapping` (the preview's `predictedMapping`, posted back by `public/lib/import_{file,text}.ts`). `import_file.ts` / `import_text.ts` parse it into `mappingObj` and create the index from it. | **Yes.** The routes already parse it. It just never reached the processor. |
| `createMode=false` (existing index, e.g. the shared `lookups` index) | `client.indices.getMapping({ index })` → `body[index].mappings`. | **Reachable with one extra call.** The route has the same `asCurrentUser` client, and `routes/preview.ts` already makes this exact call to build `existingMapping`. `analyst1`'s role grants mapping reads on `*` (see `00-current-state.md` §4), so the call should succeed for that user. If it fails anyway, the import goes ahead with no coercion. |

`dynamic` sits on the same object as `mappings.dynamic`. Importer-created indices always have
`dynamic: true` because `determineMapping` sets it.

## What actually breaks "ints into string fields"

1. **The preview infers types from row 1 only (this is the real bug).** In `routes/preview.ts` the
   call `_.mergeWith(documents, mergeCustomizerForPreview)` passes no source objects, so lodash
   hands back the `documents` array unchanged. `determineMapping(array)` then reaches the
   `Array.isArray` branch of `determineType`, which recurses into `value[0]`. Result: a column that
   is `123` in row 1 and `N/A` in row 2 gets mapped `integer`, and every non-numeric row fails with
   `mapper_parsing_exception` (U1 now reports these as one bucket). This is the "mixed-type column"
   case.
2. **Number detection is too loose.** `isNumericType` is `!isNaN(Number(v))`, which accepts
   `'007'`, `'0x1F'`, `' '` and `'Infinity'`. That means identifier-like columns (zip codes,
   zero-padded ids) get mapped `integer`: their leading zeros are lost, or the rows fail outright.
3. **CSV cells are always strings.** `fast-csv` yields strings, so a CSV sent into an *existing*
   `keyword`/`text` field does **not** fail. OpenSearch accepts `"123"` as a keyword. The CSV
   failures come from (1) and (2) in create mode, not from the existing-index path.
4. **JSON/NDJSON numbers going into keyword/text fields.** OpenSearch indexes them, but `_source`
   keeps the JSON number. Readers that trust the mapped type then find a number where they expect
   a string. That is the PPL side of task 77 (GitHub #5873, ClassCastException on type coercion).
   Converting these to strings on import makes `_source` agree with the mapping.

## What U3 implements

- **Mapping inference over all preview rows** (`determineMappingFromDocuments`). It infers each row
  and merges the results with a widening rule:
  - same type → keep it
  - `integer` + `float` → `float`; anything + `double` → `double`
  - `null` + X → X
  - any other conflict (number vs text, boolean vs number, ...) → the default `text` + `keyword`
    subfield
  - objects merge field by field

  `preview.ts` now uses it in place of the no-op `mergeWith`.
- **Stricter number detection, only inside mapping inference.** A *string* counts as numeric only
  if it matches plain decimal notation (`-?(0|[1-9]\d*)(\.\d+)?`). So `'007'`, `'0x1F'`, `'1e3'`,
  `' '` and `'Infinity'` now infer as text/keyword. Exponent forms are left out on purpose, because
  sending `"1e3"` to an `integer` field is a parse risk. `util.isNumericType` is unchanged.
  Its only remaining caller is `mergeCustomizerForPreview`, which nothing in production uses now
  that `preview.ts` calls `determineMappingFromDocuments`. I left it in place to keep this change
  small; deleting it is a separate cleanup.
- **Empty cells:** `''` still infers as text (no change), and a column that mixes empty and numeric
  cells now widens to text. Before, it was typed from row 1, and an empty string sent to a numeric
  field fails.
- **Safe coercion at import time** (`utils/coerce_to_mapping.ts`):
  - `getStringFieldPaths(mapping)` collects the dotted paths whose declared type is `text`,
    `keyword`, `match_only_text`, `wildcard` or `constant_keyword`.
  - `BulkIngester` converts `number`/`boolean` values (and arrays of them) at those paths to
    strings before sending.
  - Fields that are **not declared** in the mapping pass through unchanged, whatever the `dynamic`
    setting. That is the safe choice: under `dynamic: true` OpenSearch decides the type itself,
    and under `dynamic: strict` the bulk item fails and U1 reports the reason.
  - Numeric target fields are never coerced, because a string like `"abc"` can't become a number.
    Those failures show up in U1's `errorSummary`.
- **Routes:** create mode passes the parsed `mappingObj`, which includes `__lookup`. Existing-index
  mode calls `fetchIndexMapping` (`indices.getMapping`). If the name is an alias over a single
  index, it uses that index's mapping. If it resolves to several indices, nothing is coerced. If the
  fetch fails, the import continues without coercion and logs the failure.

## Not done / limitations

- **Dates (`// TODO Dates need further parsing`): left as is, tracked as U3b.** It is not a small change. `isValidDate`
  accepts every moment ISO-8601 form (for example `2012-07` and the week date `2012-W06-1`) plus
  RFC 2822. OpenSearch's default `date` format (`strict_date_optional_time||epoch_millis`) rejects
  several of those, and all RFC 2822 values. Mapping them to `date` would turn today's working
  text imports into bulk failures. A real fix needs either per-format detection that emits an
  explicit `format` on the mapping, or converting values to ISO when the target is `date`. I'd
  scope that as a follow-up (U3b), using the `dates-various.csv` edge-case corpus.
- **No type-override UI.** The frontend has no control for changing a predicted type. The preview
  table only *displays* predicted vs existing types and marks mismatches
  (`preview_table.tsx:50-63`). Inference across all rows plus stricter number detection fixes the
  most common mistakes. Letting users pin a column to `keyword` would be UI work (could go in
  U3b or U4).
- **Preview sample size.** Inference still only sees the first `filePreviewDocumentsCount`
  (default 10) rows. A column that changes type at row 11+ is still inferred wrong in create
  mode. Those rows now fail with a reported cause (U1) instead of failing silently.
