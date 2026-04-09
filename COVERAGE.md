# Coverage

This document describes the corpus completeness of the Greek Competition MCP.

## Data Source

**Hellenic Competition Commission (HCC)** — <https://www.epant.gr/>

The HCC is the independent administrative authority responsible for enforcing Greek competition law (Law 3959/2011 on the Protection of Free Competition).

## Decision Coverage

| Category | Coverage | Notes |
|---|---|---|
| Abuse of dominant position | 2010–present | Published in English on epant.gr |
| Cartel enforcement | 2010–present | Published in English on epant.gr |
| Sector inquiries | 2010–present | Published in English on epant.gr |
| Merger control (Phase I) | 2010–present | Published in English on epant.gr |
| Merger control (Phase II) | 2010–present | Published in English on epant.gr |

## Sector Coverage

| Sector ID | Sector Name |
|---|---|
| energy | Energy (electricity, gas, fuel) |
| food_retail | Food retail and distribution |
| telecommunications | Telecommunications and broadband |
| banking | Banking and financial services |
| pharmaceuticals | Pharmaceuticals and healthcare |
| media | Media and publishing |
| transport | Transport and logistics |

## Known Gaps

- Decisions prior to 2010 are not systematically indexed.
- Some older decisions may only be available in Greek and are not included.
- Informal guidance, dawn raid records, and settlement documents not published on epant.gr are excluded.
- Leniency application details are excluded (confidential under HCC leniency programme).

## Machine-Readable Coverage

See [`data/coverage.json`](data/coverage.json) for a machine-readable summary.

## Update Frequency

The HCC publishes decisions on an ongoing basis as they are issued. The ingest script (`scripts/ingest-hcc.ts`) should be run periodically to pull new decisions. See `.github/workflows/ingest.yml` for the scheduled ingest workflow.
