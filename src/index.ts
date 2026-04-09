#!/usr/bin/env node

/**
 * Greek Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying HCC (Hellenic Competition Commission)
 * enforcement decisions, merger control cases, and sector enforcement
 * activity under Greek competition law (Law 3959/2011). Published
 * primarily in English.
 *
 * Tool prefix: gr_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  getDataAge,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "greek-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "gr_comp_search_decisions",
    description:
      "Full-text search across HCC (Hellenic Competition Commission) enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and Law 3959/2011 articles cited. Published primarily in English.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in English (e.g., 'abuse of dominance', 'cartel pricing', 'digital markets', 'supermarkets')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'energy', 'food_retail', 'telecommunications'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_comp_get_decision",
    description:
      "Get a specific HCC decision by case number (e.g., 'HCC/700/2023', 'HCC/650/2021').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "HCC case number (e.g., 'HCC/700/2023')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "gr_comp_search_mergers",
    description:
      "Search HCC merger control decisions. Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in English (e.g., 'telecommunications merger', 'energy acquisition', 'retail concentration')",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID. Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_comp_get_merger",
    description:
      "Get a specific HCC merger control decision by case number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "HCC merger case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "gr_comp_list_sectors",
    description:
      "List all sectors with HCC enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_comp_list_sources",
    description:
      "List the primary data sources used by this MCP, including URLs, publisher, and update frequency.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_comp_check_data_freshness",
    description:
      "Check how current the data is: returns the date of the most recent decision or merger in the database and the data source update frequency.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Helpers -----------------------------------------------------------------

function responseMeta() {
  return {
    disclaimer:
      "Data sourced from HCC (https://www.epant.gr/). For informational purposes only; not legal advice.",
    data_age: getDataAge(),
    copyright: "© Hellenic Competition Commission",
    source_url: "https://www.epant.gr/",
  };
}

function textContent(data: unknown) {
  const payload = typeof data === "object" && data !== null
    ? { ...data as Record<string, unknown>, _meta: responseMeta() }
    : { data, _meta: responseMeta() };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string, errorType: string = "unknown") {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, _meta: responseMeta(), _error_type: errorType },
          null,
          2,
        ),
      },
    ],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "gr_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((r) => ({
          ...r,
          _citation: buildCitation(
            r.case_number,
            r.title,
            "gr_comp_get_decision",
            { case_number: r.case_number },
            undefined,
          ),
        }));
        return textContent({ results: resultsWithCitation, count: results.length });
      }

      case "gr_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.case_number}`, "not_found");
        }
        const d = decision as Record<string, unknown>;
        return textContent({
          ...decision,
          _citation: buildCitation(
            String(d.case_number ?? parsed.case_number),
            String(d.title ?? d.case_number ?? parsed.case_number),
            "gr_comp_get_decision",
            { case_number: parsed.case_number },
            d.url as string | undefined,
          ),
        });
      }

      case "gr_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({
          query: parsed.query,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((r) => ({
          ...r,
          _citation: buildCitation(
            r.case_number,
            r.title,
            "gr_comp_get_merger",
            { case_number: r.case_number },
            undefined,
          ),
        }));
        return textContent({ results: resultsWithCitation, count: results.length });
      }

      case "gr_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) {
          return errorContent(`Merger case not found: ${parsed.case_number}`, "not_found");
        }
        const m = merger as Record<string, unknown>;
        return textContent({
          ...merger,
          _citation: buildCitation(
            String(m.case_number ?? parsed.case_number),
            String(m.title ?? m.case_number ?? parsed.case_number),
            "gr_comp_get_merger",
            { case_number: parsed.case_number },
            m.url as string | undefined,
          ),
        });
      }

      case "gr_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }

      case "gr_comp_list_sources": {
        return textContent({
          sources: [
            {
              id: "hcc_epant",
              name: "Hellenic Competition Commission (HCC)",
              publisher: "HCC — Hellenic Competition Commission",
              url: "https://www.epant.gr/",
              content_types: ["enforcement_decisions", "merger_control", "sector_inquiries"],
              language: "English (primary), Greek",
              update_frequency: "Ongoing — new decisions published as issued",
              legal_basis: "Law 3959/2011 on the Protection of Free Competition",
            },
          ],
        });
      }

      case "gr_comp_check_data_freshness": {
        const dataAge = getDataAge();
        return textContent({
          most_recent_record_date: dataAge,
          source_update_frequency: "Ongoing — HCC publishes decisions as they are issued",
          source_url: "https://www.epant.gr/",
          note: dataAge
            ? `Database contains records up to ${dataAge}. Run the ingest script to pull newer decisions.`
            : "Database appears to be empty. Run the ingest or seed script to populate it.",
        });
      }

      case "gr_comp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "HCC (Hellenic Competition Commission) MCP server. Provides access to Greek competition law enforcement decisions, merger control cases, and sector enforcement data under Law 3959/2011 on the Protection of Free Competition. Content primarily in English.",
          data_source: "HCC (https://www.epant.gr/)",
          coverage: {
            decisions: "Abuse of dominant position, cartel enforcement, and sector inquiries under Law 3959/2011",
            mergers: "Merger control decisions — Phase I and Phase II",
            sectors: "Energy, food retail, telecommunications, banking, pharmaceuticals, media, transport",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`, "unknown_tool");
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorContent(`Invalid arguments for ${name}: ${err.message}`, "invalid_args");
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`, "unknown");
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
