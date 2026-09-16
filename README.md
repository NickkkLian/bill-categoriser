# Bill categoriser

Turn 125 synthetic bills in three inconsistent Excel tables into a workbook for month-end review. Every source row stays traceable. Rules classify merchants, exact duplicates are separated, and uncertain rows remain visible.

This is a runnable demonstration with synthetic data, not a client case study.

## Try it in 60 seconds

Tested on macOS 15.7.3 with Python 3.9.6, 3.12.4 and 3.13.9. No packages, accounts or network access are needed.

```sh
python3 -B demo.py check
python3 -B demo.py build
python3 -B demo.py check
```

On Windows, use `python` if that is your Python command. Open [the workbook](output/cleaned-bills.xlsx). The included workbook is already built, so you can inspect it before running anything.

| Seed 42 result | Rows | Known amount (CAD) |
| --- | ---: | ---: |
| Retained in Bills | 114 | 131,711.27 |
| Exact duplicates excluded | 3 | 6,256.65 |
| Unable to parse completely | 8 | 5,884.89 |
| All input rows | 125 | 143,852.81 |

**Four input amounts are unknown.** The known-amount reconciliation is `131,711.27 + 6,256.65 + 5,884.89 = 143,852.81`. This does not assign a value to a missing amount or convert the unsupported USD amount to CAD. Two possible duplicates remain in Bills pending review.

## Before and after

These examples come from `output/ledger.json`, generated with seed 42. Row IDs identify the source sheet number and Excel row, including the title/header rows.

| Source row | Before | After | Decision |
| --- | --- | --- | --- |
| Export A, row 5 | `(CAD 1,250.00)` | `-1250.00` | Retain refund; normalise the negative amount |
| Export A, row 6 | `DEMO UTILITY 02`, `2025/02/01`, `$1,453.94` | `Demo Utility 02`, `2025-02-01`, `1453.94` | Utilities, using the exact alias rule |
| Export A, row 7 | `  demo software 03  `, `08-Mar-2025` | `Demo Software 03`, `2025-03-08` | Software |
| Export A, row 10 | Missing date, amount `2224.08` | Date stays missing; amount retained in reconciliation | Unparseable; excluded from monthly totals |
| Export C, row 41 | A copy of invoice `SYN-0002` | Points to source row `1:6` | Exact duplicate, excluded once |
| Export C, row 44 | Same merchant/date/amount, invoice `SYN-0003-COPY` | Retained with a possible-duplicate warning | Human review decides whether it is a second bill |

## The five sheets

- **Summary:** monthly/category totals, merchant totals ranked at build time, high bills including large refunds, and the reconciliation. `check` compares formula text and saved cached results against Python-derived expectations; it is not a general Excel formula evaluator. It also evaluates the reconciliation's cent arithmetic and asserts an exact zero. Reconciliation uses `ROUND(amount*100,0)` before subtraction, so zero does not depend on display formatting.
- **Bills:** usable dates and amounts, original merchant text, category, review reasons, source file, sheet and Excel row.
- **Needs review:** all 39 flagged source rows with every reason, including unknown categories, malformed fields, duplicates and absolute amounts of at least CAD 2,500. A flagged row can also be retained in Bills; review is a view, not a fourth partition.
- **Duplicates:** the three exact duplicates with a pointer to the retained row.
- **Change log:** 1,004 field/header/disposition changes, each with its before/after values, rule and source.

## Rules and tradeoffs

1. `generate(seed)` creates 120 base records, three exact copies and two possible duplicates across three sheets. It deliberately includes mixed headers/date formats, merchant aliases, currency symbols, thousands separators, refunds, zero, missing fields and malformed fields.
2. Amount parsing uses integer cents. Supported amounts are CAD; dates accept only explicit year-first formats or a named month. `03/04/2025` is rejected because the source does not define a day/month order.
3. Merchant classification uses the small exact alias/category map in `demo.py`. Unknown merchants become `Uncategorised` and require review. There is **no LLM step and no API client** in this demo.
4. An exact duplicate requires invoice ID, normalised merchant, date and cents to match. A different invoice ID with the same merchant/date/cents is retained and flagged. This conservative check does not detect every fuzzy duplicate.
5. A source row belongs to exactly one of `clean`, `duplicate`, or `unparseable`. `clean` means structurally parseable, not approved for posting. Missing dates still contribute their known amounts to the control total. Missing/malformed amounts remain unknown.
6. Formula-like merchant text is stored as a literal string. It never becomes an executable Excel formula. Merchant summary criteria explicitly request text equality, so a leading `=` does not silently change the match. Input cells containing actual formulas are rejected.
7. The app fills bundled, preformatted XLSX templates using a small standard-library OOXML reader/writer. It does not need the tool used to design the templates.

### Review workload in this sample

Seed 42 with the default threshold flags **39 of 125 rows (31.2%)**. Of these, 9 have only the high-amount warning, 1 has both a high amount and another issue, and 29 have only other issues. Thus 10 rows meet the CAD 2,500 absolute-amount threshold and 30 have another reason to review; these groups overlap. The individual reason counts are: 20 unmapped merchants, 10 high amounts, 3 exact duplicates, 2 possible duplicates, 2 missing dates, 2 missing amounts, 2 invalid amounts, 1 invalid date and 1 ambiguous date. One row can contribute more than one reason, so these counts do not sum to 39.

The sample deliberately spreads base amounts across CAD 12 to 2,800, with explicit edge cases. It is a stress sample, not a measured small-business bill distribution. The default high-amount threshold is CAD 2,500. Change it at build time with `--high-cad AMOUNT`; the value is recorded in the ledger and shown in the workbook's high-bill heading and row warnings. Pass the same option to `check` for a custom build. A real intake needs an agreed threshold and a representative sample before quoting time savings.

### Checks and a deliberately broken workbook

```sh
python3 -B demo.py check
python3 -B demo.py break
```

`check` verifies all source identities, disjoint row partitions, known amounts, each output cell/formula, review/change-log contents, parsing boundaries and repeatability. It rebuilds twice in disposable directories. Both XLSX files must have exactly the same member names and decompressed bytes as each rebuild; duplicate member names are rejected. The JSON file must match byte for byte as UTF-8 with LF newlines. ZIP member order, metadata and compression bytes do not affect the XLSX comparison; changed XML, styles or added/removed members do.

The writer fixes ZIP platform metadata, attributes and timestamps, and uses uncompressed ZIP members to remove compressor-version variability from generated files. This makes the workbooks larger. Text output explicitly uses LF. The included `.gitattributes` keeps text checked out with LF even under `core.autocrlf=true`, and marks XLSX files as binary. Run `check` immediately after a clone or ZIP extraction, before any `build`; rebuilding first would overwrite the evidence of a bad delivery.

The included GitHub Actions workflow is configured to run the untouched delivered output on Ubuntu, Windows and macOS with Python 3.9 and 3.13. Checks in this folder were run locally on macOS; cross-system results should be confirmed on the repository's Actions page after publication.

`break` first deletes a Bills row in a temporary copy and launches the real checker. It then changes the source default to CAD 1,000 in an isolated copy and makes a fully consistent build; only the dedicated default review-count assertion rejects its 92 rows instead of 39. Each child checker must exit 1. The demonstration command returns 0 only when it observes both intended failures. Your delivered workbook stays intact.

For another synthetic dataset:

```sh
python3 -B demo.py build --seed 17 --out output-seed-17
python3 -B demo.py check --out output-seed-17
```

To use a different high-amount threshold, keep the build and check arguments together:

```sh
python3 -B demo.py build --high-cad 2000 --out output-high-2000
python3 -B demo.py check --high-cad 2000 --out output-high-2000
```

The checks compare the generated files, not arbitrary manually edited spreadsheets. Change the source rules and regenerate to refresh the report; build-time counts/ranking/high-bill membership do not automatically change when you edit Excel cells. Within existing ranges, amount formulas recalculate. Rebuilding replaces only the three named files in the selected output directory.

## Where this is not suitable

This is not a general Excel migration tool. The reader expects the three included sheet/header layouts and text dates; it does not support arbitrary workbooks, Excel serial dates in inputs, OCR/PDF invoices, macros, tax treatment, exchange-rate conversion or posting to accounting software. Addressing those requires explicit source mappings and additional checks. Review the workbook before using a result in another system.

Local authoring QA also recalculated formulas and rendered sheets using a separate spreadsheet engine. That authoring tool is not bundled here and is not required by `check`; visitors can reproduce the formula-text/cache comparisons and the reconciliation arithmetic with Python, but not that separate engine run. Desktop Excel was not used. Windows ZIP/text defaults were simulated on macOS, and recompressed XLSX copies passed `check`; native Windows and Linux execution has not been tested for this revision. The check code and the producer share some rules, so independent review remains useful.

MIT licensed. Copyright 2026 Nick Lian.
