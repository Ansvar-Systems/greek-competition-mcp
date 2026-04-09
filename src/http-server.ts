#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "greek-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "gr_comp_search_decisions",
    description:
      "Full-text search across HCC (Hellenic Competition Commission) enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and Law 3959/2011 articles cited. Published primarily in English.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in English (e.g., 'abuse of dominance', 'cartel pricing', 'digital markets')" },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: { type: "string", description: "Filter by sector ID (e.g., 'energy', 'food_retail'). Optional." },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
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
        case_number: { type: "string", description: "HCC case number (e.g., 'HCC/700/2023')" },
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
        query: { type: "string", description: "Search query in English (e.g., 'telecommunications merger', 'energy acquisition')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
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
        case_number: { type: "string", description: "HCC merger case number" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "gr_comp_list_sectors",
    description:
      "List all sectors with HCC enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_comp_list_sources",
    description:
      "List the primary data sources used by this MCP, including URLs, publisher, and update frequency.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_comp_check_data_freshness",
    description:
      "Check how current the data is: returns the date of the most recent decision or merger in the database and the data source update frequency.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

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

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

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
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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
              "HCC (Hellenic Competition Commission) MCP server. Provides access to Greek competition law (Law 3959/2011) enforcement decisions, merger control cases, and sector enforcement data under the Law 3959/2011 on the Protection of Free Competition.",
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

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
