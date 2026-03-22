/**
 * Seed the HCC database with sample decisions and mergers for testing.
 *
 * Includes representative HCC (Hellenic Competition Commission) decisions
 * and merger control cases in English.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["HCC_DB_PATH"] ?? "data/hcc.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow {
  id: string;
  name: string;
  name_en: string;
  description: string;
  decision_count: number;
  merger_count: number;
}

const sectors: SectorRow[] = [
  {
    id: "food_retail",
    name: "Food Retail and Distribution",
    name_en: "Food Retail and Distribution",
    description: "Supermarket chains, wholesale distribution, and food supply chains in Greece. The HCC has been active in this sector given the oligopolistic structure dominated by AB Vassilopoulos, Sklavenitis, and Lidl.",
    decision_count: 2,
    merger_count: 1,
  },
  {
    id: "energy",
    name: "Energy",
    name_en: "Energy",
    description: "Electricity, natural gas, renewables, and energy trading in Greece. PPC (Public Power Corporation) dominance investigations have been a recurring theme.",
    decision_count: 2,
    merger_count: 1,
  },
  {
    id: "telecommunications",
    name: "Telecommunications",
    name_en: "Telecommunications",
    description: "Mobile, fixed broadband, pay-TV, and telecommunications infrastructure in Greece.",
    decision_count: 1,
    merger_count: 1,
  },
  {
    id: "banking",
    name: "Banking and Financial Services",
    name_en: "Banking and Financial Services",
    description: "Commercial banks, insurance, payments infrastructure, and capital markets in Greece.",
    decision_count: 1,
    merger_count: 0,
  },
  {
    id: "pharmaceuticals",
    name: "Pharmaceuticals and Healthcare",
    name_en: "Pharmaceuticals and Healthcare",
    description: "Pharmaceutical distribution, hospitals, medical devices, and health insurance in Greece.",
    decision_count: 1,
    merger_count: 1,
  },
  {
    id: "media",
    name: "Media and Broadcasting",
    name_en: "Media and Broadcasting",
    description: "Television broadcasting, press, digital media, and advertising in Greece.",
    decision_count: 0,
    merger_count: 1,
  },
];

const insertSector = db.prepare(
  "INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const s of sectors) {
  insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
}
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow {
  case_number: string;
  title: string;
  date: string;
  type: string;
  sector: string;
  parties: string;
  summary: string;
  full_text: string;
  outcome: string;
  fine_amount: number | null;
  gwb_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    case_number: "HCC/700/2023",
    title: "PPC SA — Abuse of Dominant Position in the Greek Electricity Market",
    date: "2023-06-14",
    type: "abuse_of_dominance",
    sector: "energy",
    parties: JSON.stringify(["PPC SA (Public Power Corporation / DEH)", "PPC Renewables"]),
    summary: "The HCC fined PPC for abusing its dominant position in the Greek electricity market by engaging in margin squeeze practices against competing retail electricity suppliers, making it commercially difficult for them to serve consumers.",
    full_text: "The Hellenic Competition Commission concluded a multi-year investigation into the conduct of PPC SA (Public Power Corporation), the incumbent electricity utility in Greece.\n\nMarket Context:\nDespite liberalisation, PPC retains a dominant position in Greek electricity generation (approximately 70% of capacity) and had a legacy dominant position in retail supply. PPC controls the main lignite-fired power plants and most hydropower capacity in Greece.\n\nInfringement Found:\nThe HCC found that PPC engaged in margin squeeze — setting the wholesale electricity prices it charged competing retailers at levels that made it economically impossible for efficient competitors to operate profitably in the retail market. This is a per se abuse of dominance under Article 2 of Law 3959/2011 and Article 102 TFEU.\n\nThe margin squeeze was implemented through:\n1. High wholesale prices charged to competitors on the regulated balancing market\n2. Below-cost retail pricing by PPC's own commercial arm to key industrial customers\n3. Refusal to offer comparable loyalty discounts to rival suppliers' customers\n\nFine Calculation:\nThe fine of EUR 56 million was calculated based on the duration of the infringement (2013-2019), the gravity of the abuse, and PPC's revenues from the affected markets.\n\nPPC has appealed the decision to the Athens Administrative Court of Appeal.",
    outcome: "fine",
    fine_amount: 56_000_000,
    gwb_articles: JSON.stringify(["Art. 2 Law 3959/2011", "Art. 102 TFEU"]),
    status: "appealed",
  },
  {
    case_number: "HCC/650/2021",
    title: "AB Vassilopoulos / Carrefour — Abuse of Buyer Power in Food Supply Chain",
    date: "2021-03-25",
    type: "abuse_of_dominance",
    sector: "food_retail",
    parties: JSON.stringify(["AB Vassilopoulos SA", "Carrefour Marinopoulos SA"]),
    summary: "The HCC investigated AB Vassilopoulos (part of Ahold Delhaize) and Carrefour Marinopoulos for abuse of buyer power towards food suppliers. The companies committed to changing their procurement practices.",
    full_text: "The HCC investigated the procurement practices of the two largest supermarket chains in Greece — AB Vassilopoulos (subsidiary of Ahold Delhaize) and Carrefour Marinopoulos.\n\nInvestigation Focus:\nThe investigation examined whether the retailers abused their significant buyer power vis-a-vis food and consumer goods suppliers, in particular:\n1. Imposition of unjustified retroactive charges on suppliers\n2. Unilateral modification of supply agreements\n3. Requiring suppliers to fund store promotions and openings\n4. Excessive payment term delays (90-120 days)\n5. Discrimination between domestic and foreign suppliers\n\nGreek Supply Chain Context:\nGreek suppliers, particularly in the agricultural and food processing sectors, depend heavily on a small number of retail chains for distribution. The oligopolistic structure of Greek retail gives the chains significant bargaining power.\n\nResolution:\nBoth companies offered commitments to:\n- Eliminate retroactive charges not agreed in advance\n- Establish transparent supplier grievance procedures\n- Reduce payment terms to maximum 60 days for SME suppliers\n- Publish standard trading terms\n\nThe HCC accepted the commitments and closed the case without imposing fines, concluding that the commitments adequately addressed the identified competition concerns.",
    outcome: "cleared_with_conditions",
    fine_amount: null,
    gwb_articles: JSON.stringify(["Art. 2 Law 3959/2011"]),
    status: "final",
  },
  {
    case_number: "HCC/625/2020",
    title: "Pharmaceutical Wholesalers — Price Coordination Cartel",
    date: "2020-09-10",
    type: "cartel",
    sector: "pharmaceuticals",
    parties: JSON.stringify(["Lavipharm Laboratories SA", "Panacea Pharmaceuticals SA", "Sofarimex Greece SA", "Speciale SA"]),
    summary: "The HCC fined four pharmaceutical wholesalers for coordinating wholesale medicine prices and allocating customers. The cartel operated for approximately four years across the Greek wholesale pharmaceutical market.",
    full_text: "The Hellenic Competition Commission uncovered and sanctioned a cartel among Greek pharmaceutical wholesalers. The investigation was initiated following a leniency application by one of the participants.\n\nCartel Mechanics:\nThe four pharmaceutical wholesalers met regularly (at least quarterly) and coordinated on:\n1. Wholesale prices for prescription medicines not subject to state price regulation\n2. Allocation of pharmacy customers by geographic area\n3. Boycotting pharmacies that switched to competing wholesalers\n4. Coordinated responses to tenders for hospital medicine supply\n\nDuration: The cartel operated from approximately 2016 to 2019.\n\nLeniency Programme:\nOne participant (Lavipharm) benefited from full immunity under the HCC's leniency programme for being the first to reveal the cartel.\n\nFines Applied:\n- Panacea Pharmaceuticals: EUR 4.2 million\n- Sofarimex Greece: EUR 3.1 million\n- Speciale: EUR 2.8 million\n- Lavipharm: Immunity (leniency applicant)\n\nThe fines were calculated on the basis of the value of sales affected by the cartel, the duration of the infringement, and aggravating/mitigating factors.",
    outcome: "fine",
    fine_amount: 10_100_000,
    gwb_articles: JSON.stringify(["Art. 1 Law 3959/2011", "Art. 101 TFEU"]),
    status: "final",
  },
  {
    case_number: "HCC/680/2022",
    title: "Piraeus Bank — Loan Refinancing Terms Sector Inquiry",
    date: "2022-05-20",
    type: "sector_inquiry",
    sector: "banking",
    parties: JSON.stringify(["Piraeus Bank SA", "National Bank of Greece SA", "Alpha Bank SA", "Eurobank SA"]),
    summary: "The HCC conducted a sector inquiry into SME lending conditions in Greece. The inquiry found that SME borrowers face insufficient transparency in loan pricing and limited ability to switch lenders, weakening competitive pressure on banks.",
    full_text: "The HCC published a sector inquiry into the functioning of competition in the SME lending market in Greece. The inquiry followed concerns that Greek SMEs face unfavourable borrowing conditions compared to EU peers.\n\nGreek Banking Sector Context:\nThe Greek banking market is highly concentrated: four systemic banks (Piraeus, NBG, Alpha, Eurobank) control over 95% of deposits and credit. This concentration increased significantly during the financial crisis (2010-2018) due to consolidation.\n\nKey Findings:\n1. Pricing Opacity: SMEs reported difficulty understanding the full cost of loans, with fees and charges not always clearly disclosed upfront.\n2. Switching Barriers: Transfer of collateral and renegotiation of guarantees creates significant switching costs that lock borrowers in.\n3. Covenant Structures: Restrictive financial covenants in loan agreements limit SMEs' ability to obtain additional financing from other sources.\n4. Non-Performing Loan Legacy: The large stock of NPLs in Greek banks creates incentives to retain existing performing SME borrowers rather than compete aggressively for new ones.\n\nRecommendations:\n- Introduce standardised loan comparison tools (similar to EU mortgage credit directive requirements)\n- Simplify collateral transfer procedures\n- Require banks to provide 'switching passports' summarising loan terms for portability\n\nNo enforcement action was taken; the inquiry resulted only in recommendations.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: JSON.stringify(["Art. 23 Law 3959/2011 (sector inquiry)"]),
    status: "final",
  },
  {
    case_number: "HCC/610/2019",
    title: "Supermarket Cartel — Price Fixing in Food Retail (Athens Region)",
    date: "2019-11-28",
    type: "cartel",
    sector: "food_retail",
    parties: JSON.stringify(["Sklavenitis Group", "Masoutis SA", "Metro Cash & Carry Hellas SA"]),
    summary: "The HCC imposed fines on supermarket operators for exchanging commercially sensitive pricing information for fresh produce in the Athens region. The exchange of information facilitated tacit coordination of prices.",
    full_text: "The Hellenic Competition Commission sanctioned three supermarket operators for participating in an information exchange scheme concerning fresh produce prices in the Attica region.\n\nInfringement Description:\nThe companies participated in a structured information exchange system through which store managers shared information about fresh produce prices (fruits, vegetables, meat, dairy) on a weekly basis. While the companies did not enter into explicit price-fixing agreements, the frequent exchange of current pricing data allowed them to align prices and reduced competitive uncertainty.\n\nThe HCC found that information exchanges of this type — covering current prices, in a concentrated oligopolistic market with homogeneous products — constitute an anticompetitive agreement by object under Article 1 of Law 3959/2011 and Article 101 TFEU.\n\nFines:\n- Sklavenitis Group: EUR 5.8 million\n- Masoutis SA: EUR 3.4 million\n- Metro Cash & Carry Hellas: EUR 2.1 million\n\nMitigating factors included cooperation with the HCC investigation and implementation of compliance programmes.",
    outcome: "fine",
    fine_amount: 11_300_000,
    gwb_articles: JSON.stringify(["Art. 1 Law 3959/2011", "Art. 101 TFEU"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status);
  }
});
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow {
  case_number: string;
  title: string;
  date: string;
  sector: string;
  acquiring_party: string;
  target: string;
  summary: string;
  full_text: string;
  outcome: string;
  turnover: number | null;
}

const mergers: MergerRow[] = [
  {
    case_number: "HCC/M.2022-001",
    title: "Wind Hellas / Vodafone Greece — Telecommunications Merger",
    date: "2022-07-20",
    sector: "telecommunications",
    acquiring_party: "Wind Hellas Telecommunications SA",
    target: "Vodafone Greece (selected assets and customer base)",
    summary: "The HCC approved the Wind Hellas acquisition of selected Vodafone Greece assets, reducing the Greek mobile market from four to three operators. Remedies were required to protect MVNOs and maintain competitive pressure.",
    full_text: "The HCC examined the proposed acquisition by Wind Hellas of certain assets and the customer base of Vodafone Greece, which would reduce the number of mobile network operators (MNOs) in Greece from four to three.\n\nGreek Mobile Market Structure Pre-Merger:\n- Cosmote (OTE Group, Deutsche Telekom subsidiary): ~44% market share\n- Vodafone Greece: ~27% market share\n- Wind Hellas: ~22% market share\n- Nova Mobile: ~7% market share\n\nPost-Merger Concerns:\nConsolidation from four to three MNOs creates structural concerns: reduction of competitive dynamics, risk of coordinated behaviour in oligopolistic market, impact on MVNOs relying on wholesale access.\n\nRemedies Imposed:\n1. Wind Hellas must maintain existing MVNO access agreements for minimum 7 years\n2. New MVNO access must be offered at regulated wholesale rates\n3. Wind Hellas must divest spectrum in certain frequency bands to preserve entry opportunity\n4. Pricing safeguards for enterprise customers during 3-year transition\n\nThe HCC cleared the merger subject to these conditions, finding that they were sufficient to address competitive concerns identified in the Phase II investigation.",
    outcome: "cleared_with_conditions",
    turnover: 2_800_000_000,
  },
  {
    case_number: "HCC/M.2021-003",
    title: "Sklavenitis / AB Vassilopoulos — Food Retail Sector Consolidation",
    date: "2021-09-15",
    sector: "food_retail",
    acquiring_party: "Sklavenitis Group",
    target: "AB Vassilopoulos Stores (selected stores in overlap markets)",
    summary: "The HCC examined Sklavenitis's proposed acquisition of selected AB Vassilopoulos stores. The transaction required significant store divestiture in markets where both chains had strong local presence.",
    full_text: "The HCC conducted a Phase II investigation into the proposed acquisition by Sklavenitis of selected stores from AB Vassilopoulos (Ahold Delhaize subsidiary).\n\nMarket Context:\nGreek food retail is already highly concentrated. The acquisition would further increase concentration in several local markets where both chains operated nearby stores.\n\nLocal Market Analysis:\nThe HCC defined relevant markets at the local level (catchment area typically 15-20 minutes drive). In 23 local markets, the combined entity would have reached market shares exceeding 40% with the nearest competitor significantly smaller.\n\nRemedies:\nThe HCC required divestiture of 18 stores in local markets where competition concerns were identified:\n- 12 stores in Athens metropolitan area\n- 4 stores in Thessaloniki\n- 2 stores in other urban centres\n\nDivested stores must be sold to buyers capable of operating them as viable retail outlets, not to existing large-format retailers.\n\nThe transaction was cleared subject to these structural remedies.",
    outcome: "cleared_with_conditions",
    turnover: 3_200_000_000,
  },
  {
    case_number: "HCC/M.2023-002",
    title: "DEPA Infrastructure / Energean — Natural Gas Distribution Assets",
    date: "2023-04-28",
    sector: "energy",
    acquiring_party: "DEPA Infrastructure SA",
    target: "Energean Gas Distribution Assets (selected distribution networks)",
    summary: "The HCC cleared DEPA Infrastructure's acquisition of regional natural gas distribution networks from Energean in Phase 1. The assets were in regions where DEPA had no existing presence, eliminating overlap concerns.",
    full_text: "The HCC assessed the proposed acquisition by DEPA Infrastructure (state-controlled natural gas distribution company) of regional natural gas distribution networks previously operated by Energean.\n\nTransaction Rationale:\nThe acquired networks serve customers in Northern and Western Greece in areas not previously covered by DEPA Infrastructure. The transaction expands DEPA's geographic footprint in natural gas distribution.\n\nCompetition Analysis:\nNatural gas distribution networks are natural monopolies at the local level — only one network serves a given geographic area. There is therefore no horizontal overlap between the DEPA Infrastructure and Energean networks.\n\nPotential Concerns Assessed:\n- Vertical integration concerns: DEPA Infrastructure is related to DEPA Commercial (gas trading); could there be foreclosure of competing gas suppliers in the distribution area? The HCC assessed this risk as limited given regulatory obligations to provide non-discriminatory access.\n- Conglomerate effects: DEPA's expanded geographic presence does not fundamentally change competitive dynamics given the natural monopoly structure.\n\nThe HCC cleared the transaction in Phase 1, noting that the transaction does not raise significant competitive concerns in any relevant market.",
    outcome: "cleared_phase1",
    turnover: 450_000_000,
  },
];

const insertMerger = db.prepare(`
  INSERT OR IGNORE INTO mergers
    (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMergersAll = db.transaction(() => {
  for (const m of mergers) {
    insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover);
  }
});
insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sectors:    ${sectorCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Mergers:    ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
