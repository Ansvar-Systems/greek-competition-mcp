# Tool Reference

All tools are prefixed `gr_comp_` and operate on data from the Hellenic Competition Commission (HCC).

## gr_comp_search_decisions

Full-text search across HCC enforcement decisions (abuse of dominance, cartel, sector inquiries).

**Input**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query in English |
| `type` | enum | no | `abuse_of_dominance` \| `cartel` \| `merger` \| `sector_inquiry` |
| `sector` | string | no | Sector ID (e.g. `energy`, `food_retail`) |
| `outcome` | enum | no | `prohibited` \| `cleared` \| `cleared_with_conditions` \| `fine` |
| `limit` | number | no | Max results (default 20, max 100) |

**Response** — `{ results: Decision[], count: number, _meta }`

Each `Decision` includes `_citation` with `canonical_ref` and `lookup` pointing to `gr_comp_get_decision`.

---

## gr_comp_get_decision

Retrieve a single HCC decision by case number.

**Input**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | yes | HCC case number (e.g. `HCC/700/2023`) |

**Response** — Full `Decision` object with `_citation` and `_meta`.

---

## gr_comp_search_mergers

Search HCC merger control decisions.

**Input**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query in English |
| `sector` | string | no | Sector ID |
| `outcome` | enum | no | `cleared` \| `cleared_phase1` \| `cleared_with_conditions` \| `prohibited` |
| `limit` | number | no | Max results (default 20, max 100) |

**Response** — `{ results: Merger[], count: number, _meta }`

Each `Merger` includes `_citation` pointing to `gr_comp_get_merger`.

---

## gr_comp_get_merger

Retrieve a single HCC merger control decision by case number.

**Input**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | yes | HCC merger case number |

**Response** — Full `Merger` object with `_citation` and `_meta`.

---

## gr_comp_list_sectors

List all sectors with HCC enforcement activity.

**Input** — none

**Response** — `{ sectors: Sector[], count: number, _meta }`

Each `Sector` includes `id`, `name`, `decision_count`, `merger_count`.

---

## gr_comp_list_sources

List the primary data sources used by this MCP.

**Input** — none

**Response** — `{ sources: Source[], _meta }`

---

## gr_comp_check_data_freshness

Check how current the database is.

**Input** — none

**Response** — `{ most_recent_record_date, source_update_frequency, source_url, note, _meta }`

---

## gr_comp_about

Return metadata about this MCP server.

**Input** — none

**Response** — `{ name, version, description, data_source, coverage, tools, _meta }`

---

## Response Envelope

Every response includes a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "Data sourced from HCC (https://www.epant.gr/). For informational purposes only; not legal advice.",
    "data_age": "2024-11-15",
    "copyright": "© Hellenic Competition Commission",
    "source_url": "https://www.epant.gr/"
  }
}
```

## Error Responses

Errors include `_error_type`:

| `_error_type` | Meaning |
|---|---|
| `not_found` | Record does not exist in the database |
| `unknown_tool` | Tool name not recognised |
| `invalid_args` | Zod argument validation failed |
| `unknown` | Unexpected runtime error |
