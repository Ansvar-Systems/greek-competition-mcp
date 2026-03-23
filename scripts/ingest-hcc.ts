#!/usr/bin/env npx tsx
/**
 * Ingestion crawler for the Hellenic Competition Commission (HCC / Επιτροπή Ανταγωνισμού).
 *
 * Crawls https://www.epant.gr/apofaseis-gnomodotiseis.html — the official
 * decisions & opinions listing — and writes structured data into the local
 * SQLite database consumed by the MCP server.
 *
 * Data flow:
 *   1. Iterate year-category pages (2010–current) on epant.gr.
 *   2. Collect decision listing URLs from each paginated year page.
 *   3. Fetch each detail page, parse metadata + body text via Cheerio.
 *   4. Classify into `decisions` or `mergers` table based on tags/content.
 *   5. Upsert into SQLite with FTS triggers (schema from src/db.ts).
 *
 * Usage:
 *   npx tsx scripts/ingest-hcc.ts                    # full crawl
 *   npx tsx scripts/ingest-hcc.ts --resume            # skip already-stored case numbers
 *   npx tsx scripts/ingest-hcc.ts --dry-run            # fetch & parse, no DB writes
 *   npx tsx scripts/ingest-hcc.ts --force              # drop + re-create tables first
 *   npx tsx scripts/ingest-hcc.ts --year 2024          # single year only
 *   npx tsx scripts/ingest-hcc.ts --resume --year 2023 # combine flags
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.epant.gr";
const LISTING_PATH = "/apofaseis-gnomodotiseis/itemlist/category";
const PAGE_SIZE = 23; // epant.gr uses 23 items per page
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;

/**
 * Year-category mappings extracted from epant.gr sidebar.
 * Key = year, value = Joomla category ID.
 */
const YEAR_CATEGORIES: Record<number, number> = {
  2026: 91,
  2025: 90,
  2024: 89,
  2023: 86,
  2022: 83,
  2021: 78,
  2020: 71,
  2019: 4,
  2018: 5,
  2017: 6,
  2016: 7,
  2015: 8,
  2014: 9,
  2013: 10,
  2012: 11,
  2011: 12,
  2010: 13,
};

/** Tags (Greek) that indicate a merger/concentration decision. */
const MERGER_TAGS = new Set([
  "ΣΥΓΚΕΝΤΡΩΣΗ",
  "ΣΥΓΚΕΝΤΡΩΣΗ ΕΠΙΧΕΙΡΗΣΕΩΝ",
  "ΣΥΓΚΕΝΤΡΩΣΕΙΣ",
  "ΣΥΓΚΕΝΤΡΩΣΕΙΣ ΕΠΙΧΕΙΡΗΣΕΩΝ",
]);

/** Tags → decision type classification. */
const TYPE_TAG_MAP: Record<string, string> = {
  "ΑΥΤΕΠΑΓΓΕΛΤΗ ΕΡΕΥΝΑ": "ex_officio_investigation",
  "ΑΥΤΕΠΑΓΓΕΛΤΗΣ ΕΡΕΥΝΑΣ": "ex_officio_investigation",
  "ΚΑΡΤΕΛ": "cartel",
  "ΠΡΟΣΤΙΜΟ": "fine",
  "ΔΕΣΜΕΥΣΕΙΣ": "commitments",
  "ΔΕΣΜΕΥΣΗ": "commitments",
  "ΚΑΤΑΓΓΕΛΙΑ": "complaint",
  "ΚΛΑΔΙΚΗ ΕΡΕΥΝΑ": "sector_inquiry",
  "ΚΛΑΔΙΚΕΣ ΕΡΕΥΝΕΣ": "sector_inquiry",
  "ΣΥΜΠΡΑΞΗ": "concerted_practice",
  "ΚΑΤΑΧΡΗΣΗ ΔΕΣΠΟΖΟΥΣΑΣ ΘΕΣΗΣ": "abuse_of_dominance",
};

/** Tags → outcome classification. */
const OUTCOME_TAG_MAP: Record<string, string> = {
  "ΠΡΟΣΤΙΜΟ": "fine",
  "ΔΕΣΜΕΥΣΕΙΣ": "cleared_with_conditions",
  "ΔΕΣΜΕΥΣΗ": "cleared_with_conditions",
  "ΕΓΚΡΙΣΗ": "cleared",
  "ΕΓΚΡΙΣΗ ΜΕ ΟΡΟΥΣ": "cleared_with_conditions",
  "ΑΠΟΡΡΙΨΗ": "rejected",
  "ΑΠΟΔΟΧΗ": "cleared",
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const FLAG_RESUME = hasFlag("--resume");
const FLAG_DRY_RUN = hasFlag("--dry-run");
const FLAG_FORCE = hasFlag("--force");
const YEAR_FILTER = getFlagValue("--year")
  ? Number(getFlagValue("--year"))
  : undefined;

// ---------------------------------------------------------------------------
// HTTP helpers with retry
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  attempt = 1,
): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Ansvar-HCC-Crawler/1.0 (+https://ansvar.eu; competition-research)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "el,en;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `Failed after ${MAX_RETRIES} attempts for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const backoff = RETRY_BACKOFF_MS * attempt;
    console.warn(
      `  [retry ${attempt}/${MAX_RETRIES}] ${url} — ${err instanceof Error ? err.message : String(err)}, retrying in ${backoff}ms`,
    );
    await sleep(backoff);
    return fetchWithRetry(url, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// Listing page parser
// ---------------------------------------------------------------------------

interface ListingEntry {
  /** Relative URL path to the detail page. */
  href: string;
  /** Decision title from the listing (e.g. "Απόφαση 869/2024"). */
  title: string;
}

/**
 * Fetch a single listing page and return decision links.
 * URL pattern: /apofaseis-gnomodotiseis/itemlist/category/{catId}-{year}.html?start={offset}
 */
async function fetchListingPage(
  year: number,
  catId: number,
  offset: number,
): Promise<ListingEntry[]> {
  const params = offset > 0 ? `?start=${offset}` : "";
  const url = `${BASE_URL}${LISTING_PATH}/${catId}-${year}.html${params}`;
  console.log(`  Listing: ${url}`);

  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Decision links appear as <h3><a href="...">Title</a></h3> inside item listings.
  // Also match <h2> variants — epant.gr uses both depending on template version.
  $("h2 a, h3 a").each((_i, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim();
    if (
      href &&
      title &&
      href.includes("/apofaseis-gnomodotiseis/item/")
    ) {
      entries.push({ href, title });
    }
  });

  return entries;
}

/**
 * Collect all decision links for a given year, handling pagination.
 */
async function collectYearListings(
  year: number,
  catId: number,
): Promise<ListingEntry[]> {
  const all: ListingEntry[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(RATE_LIMIT_MS);
    const page = await fetchListingPage(year, catId, offset);
    if (page.length === 0) break;
    all.push(...page);

    // If we got fewer than PAGE_SIZE items, this is the last page.
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Detail page parser
// ---------------------------------------------------------------------------

interface ParsedDecision {
  caseNumber: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null; // JSON array
  summary: string | null;
  fullText: string;
  outcome: string | null;
  fineAmount: number | null;
  legalBasis: string | null; // stored in gwb_articles column
  tags: string[];
  isMerger: boolean;
  acquiringParty: string | null;
  target: string | null;
  turnover: number | null;
}

/**
 * Parse a decision detail page into structured data.
 */
function parseDetailPage(html: string, listingTitle: string): ParsedDecision {
  const $ = cheerio.load(html);

  // --- Case number from title ---
  // Titles follow patterns: "Απόφαση 869/2024", "Γνωμοδότηση 41/2026", "Πράξη 1/2026"
  const pageTitle =
    $("h1").first().text().trim() ||
    $(".page-header").first().text().trim() ||
    listingTitle;

  const caseMatch = pageTitle.match(
    /(?:Απόφαση|Γνωμοδότηση|Πράξη)\s+(\d+\/\d{4})/,
  );
  const caseNumber = caseMatch ? `HCC/${caseMatch[1]}` : `HCC/${pageTitle}`;

  // --- Metadata fields ---
  // epant.gr uses a definition-list or table layout for metadata.
  // Fields have Greek labels followed by values.
  const metaText = $.html() || "";

  const date = extractMetaField($, "Ημ/νία Έκδοσης Απόφασης");
  const legalBasis = extractMetaField($, "Νομικό Πλαίσιο");
  const subject = extractMetaField($, "Αντικείμενο Απόφασης");
  const marketField = extractMetaField($, "Σχετική Αγορά");
  const operative = extractMetaField($, "Διατακτικό");

  // --- Parties ---
  const partiesRaw = extractMetaField($, "Εμπλεκόμενη/ες") ||
    extractMetaField($, "Εμπλεκόμενες") ||
    extractMetaField($, "Εμπλεκόμενη");
  const parties = partiesRaw
    ? JSON.stringify(
        partiesRaw
          .split(/\n|,|·|•|\d+\.\s*/)
          .map((p) => p.trim())
          .filter((p) => p.length > 1),
      )
    : null;

  // --- Tags ---
  const tags: string[] = [];
  $("a[href*='itemlist/tag/']").each((_i, el) => {
    const tagText = $(el).text().trim().toUpperCase();
    if (tagText) tags.push(tagText);
  });

  // --- Summary (Περίληψη Απόφασης) ---
  const summary = extractSection($, "Περίληψη Απόφασης") || subject || null;

  // --- Full text: combine all content sections ---
  const bodyParts: string[] = [];
  if (subject) bodyParts.push(`Αντικείμενο: ${subject}`);
  if (marketField) bodyParts.push(`Σχετική Αγορά: ${marketField}`);
  if (legalBasis) bodyParts.push(`Νομικό Πλαίσιο: ${legalBasis}`);

  // Main article content
  const articleContent =
    $(".k2ItemsItemContent").text().trim() ||
    $(".item-page").text().trim() ||
    $("article").text().trim();
  if (articleContent) bodyParts.push(articleContent);
  if (operative) bodyParts.push(`Διατακτικό: ${operative}`);

  const summarySection = extractSection($, "Περίληψη Απόφασης");
  if (summarySection) bodyParts.push(`Περίληψη: ${summarySection}`);

  const fullText = bodyParts.join("\n\n").trim() || pageTitle;

  // --- Classification ---
  const isMerger = tags.some((t) => MERGER_TAGS.has(t)) ||
    /συγκέντρωση|συγχώνευση|απόκτηση ελέγχου|merger|concentration/i.test(
      subject || "",
    );

  const type = classifyType(tags, subject, isMerger);
  const outcome = classifyOutcome(tags, operative);

  // --- Fine amount ---
  const fineAmount = extractFineAmount(fullText);

  // --- Merger-specific fields ---
  let acquiringParty: string | null = null;
  let target: string | null = null;
  const turnover: number | null = null;

  if (isMerger && parties) {
    const partyList: string[] = JSON.parse(parties);
    if (partyList.length >= 2) {
      // Convention: first party is acquirer, rest are targets
      acquiringParty = partyList[0] ?? null;
      target = partyList.slice(1).join(", ");
    } else if (partyList.length === 1) {
      acquiringParty = partyList[0] ?? null;
    }
  }

  // --- Normalise date ---
  const normDate = normaliseDate(date);

  return {
    caseNumber,
    title: pageTitle,
    date: normDate,
    type,
    sector: guessSector(marketField, tags, fullText),
    parties,
    summary,
    fullText,
    outcome,
    fineAmount,
    legalBasis,
    tags,
    isMerger,
    acquiringParty,
    target,
    turnover,
  };
}

// ---------------------------------------------------------------------------
// Metadata extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a metadata value by its Greek label.
 * epant.gr uses various structures: <strong>Label:</strong> value,
 * <dt>Label</dt><dd>value</dd>, or table rows.
 */
function extractMetaField(
  $: cheerio.CheerioAPI,
  label: string,
): string | null {
  // Strategy 1: find any element containing the label text, grab sibling/next text
  let result: string | null = null;

  // Look in all text nodes — label followed by value
  $("strong, b, dt, th, span.field-label").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.includes(label)) {
      // Value is in the next sibling, parent's next child, or dd element
      const next =
        $(el).next("dd, td, span, div").text().trim() ||
        $(el).parent().text().replace(text, "").trim() ||
        $(el).parent().next().text().trim();
      if (next) result = next;
    }
  });

  return result || null;
}

/**
 * Extract a named section's text content.
 * Sections are typically headed by <strong>Heading</strong> or <h3>Heading</h3>.
 */
function extractSection(
  $: cheerio.CheerioAPI,
  heading: string,
): string | null {
  let found = false;
  let content = "";

  $("strong, b, h3, h4").each((_i, el) => {
    if (found) return; // already found our section
    const text = $(el).text().trim();
    if (text.includes(heading)) {
      // Collect text from subsequent siblings until next heading
      let node = $(el).parent().next();
      const parts: string[] = [];
      for (let j = 0; j < 20 && node.length > 0; j++) {
        const nodeText = node.text().trim();
        // Stop at next section heading
        if (node.find("strong, h3, h4").length > 0 && parts.length > 0) break;
        if (nodeText) parts.push(nodeText);
        node = node.next();
      }
      if (parts.length > 0) {
        content = parts.join("\n");
        found = true;
      }
    }
  });

  return content || null;
}

/**
 * Classify decision type from tags and subject text.
 */
function classifyType(
  tags: string[],
  subject: string | null,
  isMerger: boolean,
): string | null {
  if (isMerger) return "merger";

  for (const tag of tags) {
    const mapped = TYPE_TAG_MAP[tag];
    if (mapped) return mapped;
  }

  // Fallback: check subject text
  if (subject) {
    const lower = subject.toLowerCase();
    if (/καρτέλ|σύμπραξη|οριζόντια συμφωνία/.test(lower)) return "cartel";
    if (/κατάχρηση|δεσπόζουσα/.test(lower)) return "abuse_of_dominance";
    if (/κλαδική έρευνα/.test(lower)) return "sector_inquiry";
    if (/καταγγελία/.test(lower)) return "complaint";
    if (/αυτεπάγγελτη/.test(lower)) return "ex_officio_investigation";
  }

  return null;
}

/**
 * Classify outcome from tags and operative text.
 */
function classifyOutcome(
  tags: string[],
  operative: string | null,
): string | null {
  for (const tag of tags) {
    const mapped = OUTCOME_TAG_MAP[tag];
    if (mapped) return mapped;
  }

  if (operative) {
    const lower = operative.toLowerCase();
    if (/πρόστιμο|επιβάλλει/.test(lower)) return "fine";
    if (/δεσμεύσεις|αποδέχεται/.test(lower)) return "cleared_with_conditions";
    if (/εγκρίνει/.test(lower)) return "cleared";
    if (/απορρίπτει/.test(lower)) return "rejected";
  }

  return null;
}

/**
 * Extract fine amount from full text. Returns value in EUR or null.
 */
function extractFineAmount(text: string): number | null {
  // Patterns: "EUR 56.000.000", "€ 4.200.000", "56 εκατ.", "4,2 εκ. ευρώ"
  const patterns = [
    /(?:EUR|€)\s*([\d.,]+)\s*(?:εκατ(?:ομμύρια|\.)?|million)?/gi,
    /([\d.,]+)\s*(?:εκατ(?:ομμύρια|\.)?|million)\s*(?:ευρώ|EUR|€)/gi,
    /πρόστιμο\s+(?:ύψους\s+)?(?:EUR|€)?\s*([\d.,]+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      // Greek number format: 1.000.000,50 → 1000000.50
      let numStr = match[1]
        .replace(/\./g, "")
        .replace(",", ".");
      let value = parseFloat(numStr);
      if (isNaN(value)) continue;

      // Check for "εκατ" (millions) nearby
      const surrounding = text.substring(
        Math.max(0, (match.index ?? 0) - 5),
        (match.index ?? 0) + match[0].length + 30,
      );
      if (/εκατ|million/i.test(surrounding) && value < 10000) {
        value *= 1_000_000;
      }

      if (value > 0) return value;
    }
  }

  return null;
}

/**
 * Guess sector from market field, tags, and full text.
 */
function guessSector(
  market: string | null,
  tags: string[],
  text: string,
): string | null {
  const combined = [market || "", ...tags, text.substring(0, 2000)]
    .join(" ")
    .toLowerCase();

  const sectorPatterns: [RegExp, string][] = [
    [/τηλεπικοινων|telecoms|κινητ(?:ή|ές) τηλεφων/, "telecommunications"],
    [/ενέργει|ηλεκτρικ|φυσικ(?:ό|ού) αερ|energy|electricity/, "energy"],
    [/τράπεζ|τραπεζικ|πιστωτικ|banking|bank/, "banking"],
    [/φαρμακ|υγεί|νοσοκομ|pharma|health/, "pharmaceuticals"],
    [/τρόφιμ|λιανικ|σούπερ μάρκετ|food|retail|supermarket/, "food_retail"],
    [/μεταφορ|αεροπορ|ναυτιλ|transport|aviation|shipping/, "transport"],
    [/κατασκευ|οικοδομ|construction|building/, "construction"],
    [/ψηφιακ|πληροφορικ|digital|technology|software/, "technology"],
    [/μέσα ενημέρωσης|τηλεόραση|media|broadcast/, "media"],
    [/ασφάλει|ασφαλιστ|insurance/, "insurance"],
    [/τουρισμ|ξενοδοχ|tourism|hotel/, "tourism"],
    [/αυτοκίνητ|οχήματ|automotive|vehicle/, "automotive"],
  ];

  for (const [pattern, sector] of sectorPatterns) {
    if (pattern.test(combined)) return sector;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date normalisation
// ---------------------------------------------------------------------------

const GREEK_MONTHS: Record<string, string> = {
  "ιανουαρίου": "01",
  "φεβρουαρίου": "02",
  "μαρτίου": "03",
  "απριλίου": "04",
  "μαΐου": "05",
  "μαίου": "05",
  "ιουνίου": "06",
  "ιουλίου": "07",
  "αυγούστου": "08",
  "σεπτεμβρίου": "09",
  "οκτωβρίου": "10",
  "νοεμβρίου": "11",
  "δεκεμβρίου": "12",
};

/**
 * Normalise Greek-formatted dates to ISO 8601 (YYYY-MM-DD).
 *
 * Input formats:
 *   "20/12/2024"
 *   "04η Νοεμβρίου 2025"
 *   "Τρίτη, 10 Μαρτίου 2026"
 *   "30.08.2024"
 */
function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // DD/MM/YYYY or DD.MM.YYYY
  const slashMatch = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (slashMatch) {
    const [, dd, mm, yyyy] = slashMatch;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }

  // Greek month name: "04η Νοεμβρίου 2025" or "10 Μαρτίου 2026"
  const greekMatch = s.match(
    /(\d{1,2})(?:η|ης)?\s+(\S+)\s+(\d{4})/i,
  );
  if (greekMatch) {
    const [, dd, monthName, yyyy] = greekMatch;
    const mm = GREEK_MONTHS[monthName!.toLowerCase()];
    if (mm) {
      return `${yyyy}-${mm}-${dd!.padStart(2, "0")}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  const dbPath = process.env["HCC_DB_PATH"] ?? "data/hcc.db";
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (FLAG_FORCE && existsSync(dbPath)) {
    unlinkSync(dbPath);
    console.log(`[force] Deleted existing database at ${dbPath}`);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function existingCaseNumbers(db: Database.Database): Set<string> {
  const set = new Set<string>();
  const rows = db
    .prepare("SELECT case_number FROM decisions")
    .all() as { case_number: string }[];
  for (const r of rows) set.add(r.case_number);

  const mrows = db
    .prepare("SELECT case_number FROM mergers")
    .all() as { case_number: string }[];
  for (const r of mrows) set.add(r.case_number);

  return set;
}

function upsertDecision(db: Database.Database, d: ParsedDecision): void {
  db.prepare(
    `INSERT INTO decisions
       (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
     VALUES
       (@caseNumber, @title, @date, @type, @sector, @parties, @summary, @fullText, @outcome, @fineAmount, @legalBasis, 'final')
     ON CONFLICT(case_number) DO UPDATE SET
       title      = excluded.title,
       date       = excluded.date,
       type       = excluded.type,
       sector     = excluded.sector,
       parties    = excluded.parties,
       summary    = excluded.summary,
       full_text  = excluded.full_text,
       outcome    = excluded.outcome,
       fine_amount = excluded.fine_amount,
       gwb_articles = excluded.gwb_articles`,
  ).run({
    caseNumber: d.caseNumber,
    title: d.title,
    date: d.date,
    type: d.type,
    sector: d.sector,
    parties: d.parties,
    summary: d.summary,
    fullText: d.fullText,
    outcome: d.outcome,
    fineAmount: d.fineAmount,
    legalBasis: d.legalBasis,
  });
}

function upsertMerger(db: Database.Database, d: ParsedDecision): void {
  db.prepare(
    `INSERT INTO mergers
       (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
     VALUES
       (@caseNumber, @title, @date, @sector, @acquiringParty, @target, @summary, @fullText, @outcome, @turnover)
     ON CONFLICT(case_number) DO UPDATE SET
       title           = excluded.title,
       date            = excluded.date,
       sector          = excluded.sector,
       acquiring_party = excluded.acquiring_party,
       target          = excluded.target,
       summary         = excluded.summary,
       full_text       = excluded.full_text,
       outcome         = excluded.outcome,
       turnover        = excluded.turnover`,
  ).run({
    caseNumber: d.caseNumber,
    title: d.title,
    date: d.date,
    sector: d.sector,
    acquiringParty: d.acquiringParty,
    target: d.target,
    summary: d.summary,
    fullText: d.fullText,
    outcome: d.outcome,
    turnover: d.turnover,
  });
}

/**
 * Rebuild sector counts from actual decision/merger data.
 */
function refreshSectorCounts(db: Database.Database): void {
  const sectors = new Map<string, { decisions: number; mergers: number }>();

  const dRows = db
    .prepare("SELECT sector, count(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector")
    .all() as { sector: string; cnt: number }[];
  for (const r of dRows) {
    const entry = sectors.get(r.sector) ?? { decisions: 0, mergers: 0 };
    entry.decisions = r.cnt;
    sectors.set(r.sector, entry);
  }

  const mRows = db
    .prepare("SELECT sector, count(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector")
    .all() as { sector: string; cnt: number }[];
  for (const r of mRows) {
    const entry = sectors.get(r.sector) ?? { decisions: 0, mergers: 0 };
    entry.mergers = r.cnt;
    sectors.set(r.sector, entry);
  }

  const upsert = db.prepare(
    `INSERT INTO sectors (id, name, decision_count, merger_count)
     VALUES (@id, @name, @dc, @mc)
     ON CONFLICT(id) DO UPDATE SET
       decision_count = excluded.decision_count,
       merger_count   = excluded.merger_count`,
  );

  for (const [id, counts] of sectors) {
    upsert.run({
      id,
      name: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      dc: counts.decisions,
      mc: counts.mergers,
    });
  }
}

// ---------------------------------------------------------------------------
// Main crawl loop
// ---------------------------------------------------------------------------

interface CrawlStats {
  years: number;
  listed: number;
  fetched: number;
  decisions: number;
  mergers: number;
  skipped: number;
  errors: number;
}

async function crawl(): Promise<void> {
  console.log("=== HCC Ingestion Crawler ===");
  console.log(`  Mode: ${FLAG_DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Resume: ${FLAG_RESUME}`);
  console.log(`  Force: ${FLAG_FORCE}`);
  if (YEAR_FILTER) console.log(`  Year filter: ${YEAR_FILTER}`);
  console.log();

  const db = FLAG_DRY_RUN ? null : openDb();
  const known = db && FLAG_RESUME ? existingCaseNumbers(db) : new Set<string>();

  if (FLAG_RESUME && known.size > 0) {
    console.log(`  Resume: ${known.size} existing records will be skipped\n`);
  }

  const stats: CrawlStats = {
    years: 0,
    listed: 0,
    fetched: 0,
    decisions: 0,
    mergers: 0,
    skipped: 0,
    errors: 0,
  };

  // Determine which years to crawl (descending — newest first)
  const years = Object.entries(YEAR_CATEGORIES)
    .map(([y, catId]) => ({ year: Number(y), catId }))
    .filter(({ year }) => (YEAR_FILTER ? year === YEAR_FILTER : true))
    .sort((a, b) => b.year - a.year);

  if (years.length === 0) {
    console.error(`No matching year found for --year ${YEAR_FILTER}`);
    process.exit(1);
  }

  for (const { year, catId } of years) {
    console.log(`\n--- ${year} (category ${catId}) ---`);
    stats.years++;

    let entries: ListingEntry[];
    try {
      entries = await collectYearListings(year, catId);
    } catch (err) {
      console.error(
        `  Failed to fetch listings for ${year}: ${err instanceof Error ? err.message : String(err)}`,
      );
      stats.errors++;
      continue;
    }

    console.log(`  Found ${entries.length} entries`);
    stats.listed += entries.length;

    for (const entry of entries) {
      // Build case number candidate for resume check
      const caseMatch = entry.title.match(
        /(?:Απόφαση|Γνωμοδότηση|Πράξη)\s+(\d+\/\d{4})/,
      );
      const candidateCaseNumber = caseMatch
        ? `HCC/${caseMatch[1]}`
        : null;

      if (FLAG_RESUME && candidateCaseNumber && known.has(candidateCaseNumber)) {
        stats.skipped++;
        continue;
      }

      // Rate limit
      await sleep(RATE_LIMIT_MS);

      const detailUrl = entry.href.startsWith("http")
        ? entry.href
        : `${BASE_URL}${entry.href}`;

      let html: string;
      try {
        html = await fetchWithRetry(detailUrl);
        stats.fetched++;
      } catch (err) {
        console.error(
          `  [error] ${entry.title}: ${err instanceof Error ? err.message : String(err)}`,
        );
        stats.errors++;
        continue;
      }

      let parsed: ParsedDecision;
      try {
        parsed = parseDetailPage(html, entry.title);
      } catch (err) {
        console.error(
          `  [parse-error] ${entry.title}: ${err instanceof Error ? err.message : String(err)}`,
        );
        stats.errors++;
        continue;
      }

      const kind = parsed.isMerger ? "merger" : "decision";
      console.log(
        `  ${kind}: ${parsed.caseNumber} — ${parsed.title.substring(0, 60)}${parsed.title.length > 60 ? "..." : ""}`,
      );

      if (!FLAG_DRY_RUN && db) {
        try {
          if (parsed.isMerger) {
            upsertMerger(db, parsed);
            stats.mergers++;
          } else {
            upsertDecision(db, parsed);
            stats.decisions++;
          }
        } catch (err) {
          console.error(
            `  [db-error] ${parsed.caseNumber}: ${err instanceof Error ? err.message : String(err)}`,
          );
          stats.errors++;
        }
      } else {
        // Dry run — still count
        if (parsed.isMerger) stats.mergers++;
        else stats.decisions++;
      }
    }
  }

  // Refresh sector counts
  if (!FLAG_DRY_RUN && db) {
    refreshSectorCounts(db);
    console.log("\nSector counts refreshed.");
  }

  // Summary
  console.log("\n=== Crawl Complete ===");
  console.log(`  Years crawled:  ${stats.years}`);
  console.log(`  Entries listed: ${stats.listed}`);
  console.log(`  Pages fetched:  ${stats.fetched}`);
  console.log(`  Decisions:      ${stats.decisions}`);
  console.log(`  Mergers:        ${stats.mergers}`);
  console.log(`  Skipped:        ${stats.skipped}`);
  console.log(`  Errors:         ${stats.errors}`);

  if (!FLAG_DRY_RUN && db) {
    const dc = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
    const mc = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
    const sc = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
    console.log(`\nDatabase totals:`);
    console.log(`  Decisions: ${dc}`);
    console.log(`  Mergers:   ${mc}`);
    console.log(`  Sectors:   ${sc}`);
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

crawl().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
