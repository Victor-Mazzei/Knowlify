import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqlitePassageRepository, toFtsPlan } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import type { Book } from "../src/ports/index.js";
import type { Passage } from "../src/domain/knowledge/BookIndex.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const frequencies = (table: Record<string, number>) =>
  (text: string): number => table[text] ?? 0;

const book = (id = "book"): Book => ({
  id, title: `Title ${id}`, author: "Author", format: "pdf", path: `/library/${id}.pdf`,
  cover_path: null, size: 10, added_at: 1, source_id: "source", mtime: 1, status: "ready",
});

const passage = (ordinal: number, text: string): Passage => ({ ordinal, text, page: ordinal + 1, section: null });

describe("layered plan (budget)", () => {
  it("keeps the 2.0.4 expression and exposes the estimate for the runtime budget", () => {
    const plan = toFtsPlan("attention memory", {
      documentFrequency: frequencies({ attention: 500_000, memory: 450_000 }),
      totalRows: 1_000_000,
    });
    expect(plan.primary).toBe('"attention"* AND "memory"*');
    expect(plan.estimatedRows).toBe(450_000);
    expect(plan.estimatedRowTerms).toBe(900_000);
    // The cheap expression is always available; the repository decides from the deadline.
    expect(plan.budget?.primary).toBe('"attention" AND "memory"');
  });

  it("renders common terms as exact tokens in the cheap plan", () => {
    const plan = toFtsPlan("function declaration scope memory", {
      documentFrequency: frequencies({ function: 900_000, declaration: 950_000, scope: 990_000, memory: 995_000 }),
      totalRows: 1_000_000,
    });
    expect(plan.primary).toBe('"function"* AND "declaration"* AND "scope"* AND "memory"*');
    expect(plan.budget?.primary).toBe('"function" AND "declaration" AND "scope"');
    expect(plan.budget?.terms).toBe(3);
  });

  it("keeps only the three lowest-df terms in the cheap AND", () => {
    const terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "iota", "kappa", "lambda"];
    const table = Object.fromEntries(terms.map((term, index) => [term, 900_000 + index * 10_000]));
    const plan = toFtsPlan(terms.join(" "), {
      documentFrequency: frequencies(table),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(plan.terms).toBe(10);
    expect(plan.budget?.terms).toBe(3);
    for (const term of ["alpha", "beta", "gamma"]) expect(plan.budget!.primary).toContain(`"${term}"`);
    for (const term of terms.slice(3)) expect(plan.budget!.primary).not.toContain(`"${term}"`);
    // Common terms are exact; no prefix survives in the cheap expression.
    expect(plan.budget!.primary).not.toContain("*");
  });

  it("preserves the rare union while common terms stay exact", () => {
    const plan = toFtsPlan("attention function scope memory neuroscience", {
      documentFrequency: frequencies({
        attention: 900_000, function: 950_000, scope: 970_000, memory: 990_000, neuroscience: 5,
      }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(plan.rare).toBe(1);
    expect(plan.budget!.primary).toContain('"neuroscience"*');
    // The fifth (and most common) term is dropped from the cheap AND, never ORed.
    expect(plan.budget!.primary).not.toContain("memory");
  });

  it("pins protected short terms and numbers in the cheap AND", () => {
    const plan = toFtsPlan('C++ R function declaration scope memory', {
      documentFrequency: frequencies({
        c: 300_000, r: 250_000, function: 900_000, declaration: 950_000, scope: 990_000, memory: 995_000,
      }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(plan.budget!.primary).toContain('"c"');
    expect(plan.budget!.primary).toContain('"r"');
    expect(plan.budget!.primary).toContain('"function"');
    expect(plan.budget!.primary).not.toContain('"declaration"');
    expect(plan.budget!.primary).not.toContain('"scope"');
    expect(plan.budget!.primary).not.toContain("*");
  });

  it("never lets the three-term limit drop a protected short term or number", () => {
    const plan = toFtsPlan("C R Go 2024 memory", {
      documentFrequency: frequencies({
        c: 900_000, r: 800_000, go: 700_000, "2024": 500_000, memory: 990_000,
      }),
      totalRows: 1_000_000,
    });
    expect(plan.rare).toBe(0);
    expect(plan.budget!.primary).toBe('"c" AND "r" AND "go" AND "2024"');
    // The common term has no slot left; it cannot displace a protected one.
    expect(plan.budget!.primary).not.toContain("memory");
  });

  it("keeps a single common term exact and never builds an identical budget", () => {
    const plan = toFtsPlan("attention", {
      documentFrequency: frequencies({ attention: 900_000 }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(plan.primary).toBe('"attention"*');
    expect(plan.budget?.primary).toBe('"attention"');
    const rare = toFtsPlan("neuroscience", {
      documentFrequency: frequencies({ neuroscience: 5 }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(rare.budget).toBeUndefined();
  });

  it("builds an exact bounded fallback only without rare terms", () => {
    const plan = toFtsPlan("function declaration", {
      documentFrequency: frequencies({ function: 900_000, declaration: 900_000 }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(plan.rare).toBe(0);
    expect(plan.budget!.fallback).toBe('"declaration" OR "function"');
    const withRare = toFtsPlan("function declaration neuroscience", {
      documentFrequency: frequencies({ function: 900_000, declaration: 900_000, neuroscience: 5 }),
      totalRows: 1_000_000,
      fullBudgetMs: 0,
    });
    expect(withRare.rare).toBe(1);
    expect(withRare.budget!.fallback).toBeUndefined();
  });
});

interface Seeded {
  db: Db;
  passages: SqlitePassageRepository;
}

function seeded(text: (ordinal: number) => string, chunks = 200): Seeded {
  const db = openDb(":memory:");
  databases.push(db);
  new SqliteBookRepository(db).save(book());
  const passages = new SqlitePassageRepository(db);
  passages.append("book", Array.from({ length: chunks }, (_, ordinal) => ({
    passage: passage(ordinal, text(ordinal)),
    vector: null,
  })));
  return { db, passages };
}

const incident = "extern C declaration definition function block scope memory code program";

describe("layered search in the repository", () => {
  it("returns the cheap layer without running the full pass when it fills the request", () => {
    const { passages } = seeded((ordinal) => `${incident} passage ${ordinal}`);
    const layers: string[] = [];
    let complete: boolean | undefined;
    // Under the corpus threshold the rule does not apply; the forced threshold makes the
    // dense C++ query take the layered path, exactly the production shape.
    const hits = passages.searchLexical(incident, 10, undefined, {
      fullBudgetMs: 0,
      onLayer: (layer) => layers.push(layer),
      onComplete: (value) => { complete = value; },
    });
    expect(hits).toHaveLength(10);
    expect(layers).toEqual(["cheap"]);
    // The cheap layer filled the request, but the full ranking never ran: not cacheable.
    expect(complete).toBe(false);
  });

  it("reports a complete result when the full plan ran", () => {
    const { passages } = seeded((ordinal) => `${incident} passage ${ordinal}`);
    let complete: boolean | undefined;
    passages.searchLexical(incident, 10, undefined, {
      onComplete: (value) => { complete = value; },
    });
    expect(complete).toBe(true);
  });

  it("reports an exceeded deadline as incomplete even when the full plan ran", () => {
    const { passages } = seeded((ordinal) => ordinal < 2
      ? `neuroscience ${incident} passage ${ordinal}`
      : `${incident} passage ${ordinal}`);
    let complete: boolean | undefined;
    passages.searchLexical("neuroscience", 10, undefined, {
      // A single rare term has no cheaper plan, so the full pass runs and the deadline is
      // the only thing that marks the read as too late for the cache.
      timeoutAt: Date.now() - 1_000,
      onComplete: (value) => { complete = value; },
    });
    expect(complete).toBe(false);
  });

  it("runs the full ranking when the cheap layer is short and the budget allows", () => {
    const { passages } = seeded((ordinal) => ordinal < 5 ? `${incident} passage ${ordinal}` : `noise ${ordinal}`);
    const layers: string[] = [];
    const hits = passages.searchLexical(incident, 10, undefined, {
      fullBudgetMs: 0,
      onLayer: (layer) => layers.push(layer),
    });
    expect(layers).toEqual(["cheap", "full"]);
    expect(hits).toHaveLength(5);
  });

  it("skips the full pass when the remaining worker budget cannot cover it", () => {
    const { passages } = seeded((ordinal) => ordinal < 5 ? `${incident} passage ${ordinal}` : `noise ${ordinal}`);
    const layers: string[] = [];
    // A deadline in the past means "no room for the full pass". The cheap hits must survive:
    // returning empty here would be the production failure this layer exists to avoid.
    const hits = passages.searchLexical(incident, 10, undefined, {
      fullBudgetMs: 0,
      timeoutAt: Date.now() - 1_000,
      onLayer: (layer) => layers.push(layer),
    });
    expect(layers).toEqual(["cheap", "full-skipped"]);
    expect(hits).toHaveLength(5);
  });

  it("uses the exact bounded fallback when the cheap AND is empty and no term is rare", () => {
    const { passages } = seeded((ordinal) => ordinal % 2 === 0 ? `function only ${ordinal}` : `declaration only ${ordinal}`);
    const layers: string[] = [];
    const hits = passages.searchLexical("function declaration", 10, undefined, {
      fullBudgetMs: 0,
      timeoutAt: Date.now() - 1_000,
      onLayer: (layer) => layers.push(layer),
    });
    expect(layers).toEqual(["cheap", "full-skipped", "fallback"]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("keeps short exact terms working under the layered rule", () => {
    const db = openDb(":memory:");
    databases.push(db);
    new SqliteBookRepository(db).save(book());
    const passages = new SqlitePassageRepository(db);
    passages.append("book", [
      { passage: passage(0, "C++ templates and generics"), vector: null },
      { passage: passage(1, "The R language for statistics"), vector: null },
      { passage: passage(2, "Cats are not dogs"), vector: null },
      { passage: passage(3, "Section 7 exercises"), vector: null },
    ]);
    const cpp = passages.searchLexical("C++", 4, undefined, { fullBudgetMs: 0 });
    expect(cpp).toHaveLength(1);
    expect(passages.searchLexical("C", 4, undefined, { fullBudgetMs: 0 })).toHaveLength(1);
    expect(passages.searchLexical("R", 4, undefined, { fullBudgetMs: 0 })).toHaveLength(1);
    expect(passages.searchLexical("7", 4, undefined, { fullBudgetMs: 0 })).toHaveLength(1);
  });

  it("keeps 2024 ahead of 1999 when the cheap plan is forced", () => {
    const db = openDb(":memory:");
    databases.push(db);
    new SqliteBookRepository(db).save(book());
    const passages = new SqlitePassageRepository(db);
    // All query terms are common (rare = 0), so the cheap AND is the only guard: the
    // protected 2024 must stay even with four protected terms and no common slot left.
    const common = Array.from({ length: 50 }, (_, index) => ({
      passage: passage(100 + index, `C R Go memory noise ${index}`), vector: null,
    }));
    const moreCommon = Array.from({ length: 50 }, (_, index) => ({
      passage: passage(200 + index, `C R Go noise ${index}`), vector: null,
    }));
    const yearFillers = Array.from({ length: 9 }, (_, index) => ({
      passage: passage(300 + index, `2024 archive ${index}`), vector: null,
    }));
    passages.append("book", [
      { passage: passage(0, "C R Go 2024 memory"), vector: null },
      // The 1999 passage repeats the common terms, so it wins the cheap AND that lost 2024.
      { passage: passage(1, "C R Go C R Go C R Go 1999 memory"), vector: null },
      ...common,
      ...moreCommon,
      ...yearFillers,
    ]);
    const winner = (db.prepare("SELECT id FROM chunks WHERE text = ?")
      .get("C R Go 2024 memory") as { id: number }).id;
    const layers: string[] = [];

    const hits = passages.searchLexical("C R Go 2024 memory", 1, undefined, {
      fullBudgetMs: 0,
      onLayer: (layer) => layers.push(layer),
    });

    expect(layers).toEqual(["cheap"]);
    expect(hits[0]?.passageId).toBe(winner);
  });
});

describe("join removal (T3b)", () => {
  it("does not read the passage text for the unfiltered ranked query", () => {
    const { db } = seeded(() => "deep work attention", 10);
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT chunks_fts.rowid AS passageId, bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT 32
    `).all('"attention"*') as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).not.toMatch(/SEARCH \w+ USING INTEGER PRIMARY KEY/);

    // With a book filter the join is the measured winner: an `IN (SELECT id FROM chunks)`
    // plan reads every match and probes membership (0.78 s vs 26 ms in the T0 lab), so the
    // bounded join stays.
    const filtered = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT c.id AS passageId, bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? AND c.book_id = ?
      ORDER BY rank LIMIT 32
    `).all('"attention"*', "book") as { detail: string }[];
    expect(filtered.map((row) => row.detail).join(" ")).toContain("SEARCH c USING INTEGER PRIMARY KEY");
  });
});
