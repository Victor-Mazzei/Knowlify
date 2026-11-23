/**
 * FTS5 query planning for passage retrieval.
 *
 * The corpus is large enough that every extra prefix term multiplies the rows `bm25` has
 * to score, and a natural-language question carries a lot of words that add no ranking
 * signal. The planner keeps the query selective without changing the HTTP contract:
 *
 * - Portuguese, English and Spanish stopwords and question scaffolding are dropped;
 * - prefix matching starts at three characters; short terms and numbers match exactly,
 *   which keeps `C`, `R`, `Go`, `C++` and meaningful numbers searchable without turning
 *   one or two letters into a whole-corpus prefix scan;
 * - at most ten informative terms stay; with corpus access the terms are selected by df;
 * - the primary query is `AND` of every present term plus an `OR` union of the rare ones
 *   (all rare simplifies to the `OR`). Common terms are never a standalone `OR` in the
 *   primary. Only when there is no rare term at all and the `AND` is empty, the three
 *   lowest-df terms are ORed as the single bounded fallback.
 */

/** Longest terms kept. */
const MAX_TERMS = 10;
const PREFIX_MIN_CHARS = 3;
/** Guards a pathological query made only of one-letter tokens. */
const SINGLE_CHAR_TERM_LIMIT = 4;

export interface FtsPlan {
  /** Expression tried first. */
  primary: string;
  /** `OR` of the three lowest-df terms; only allowed when no term is rare and the AND is empty. */
  fallback?: string;
  /** Number of informative terms kept. */
  terms: number;
  /** Number of terms classified rare by df. */
  rare: number;
}

export interface FtsPlanOptions {
  /** Document frequency (rows containing the term) for a query term. */
  documentFrequency?: (text: string, prefix: boolean) => number;
  /** Number of indexed rows, for the rare threshold. */
  totalRows?: number;
  /** Rare terms are at most this fraction of rows (default 2%). */
  rareFraction?: number;
  /** Absolute rare ceiling (default 20,000 rows). */
  rareCap?: number;
}

const DEFAULT_RARE_FRACTION = 0.02;
const DEFAULT_RARE_CAP = 20_000;

interface Candidate {
  text: string;
  key: string;
  exact: boolean;
  protectedTerm: boolean;
  order: number;
  /** Document frequency, filled when the caller provides corpus access. */
  df?: number;
}

const STOPWORDS = new Set([
  // English
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could", "did", "do",
  "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has", "have", "having", "he",
  "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "itself", "just", "may", "me", "might", "more", "most", "must", "my", "myself", "no", "nor", "not", "now", "of",
  "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same", "shall", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
  "yourself", "yourselves",
  // Portuguese
  "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as", "ate", "com", "como", "da", "das",
  "de", "dela", "delas", "dele", "deles", "depois", "do", "dos", "e", "ela", "elas", "ele", "eles", "em", "entre",
  "era", "eram", "essa", "essas", "esse", "esses", "esta", "estas", "este", "estes", "eu", "foi", "foram", "ha",
  "isso", "isto", "ja", "lhe", "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas", "muito", "na",
  "nao", "nas", "nem", "no", "nos", "num", "numa", "o", "os", "ou", "para", "pela", "pelas", "pelo", "pelos", "por",
  "qual", "quais", "quando", "que", "quem", "se", "sem", "seu", "seus", "so", "sua", "suas", "tambem", "te", "tem",
  "tu", "um", "uma", "umas", "uns", "voce", "voces",
  // Spanish
  "a", "al", "algo", "algunas", "algunos", "ante", "antes", "como", "con", "contra", "cual", "cuales", "cuando", "de",
  "del", "desde", "donde", "dos", "el", "ella", "ellas", "ellos", "en", "entre", "era", "eran", "es", "esa", "esas",
  "ese", "esos", "esta", "estas", "este", "estos", "fue", "fueron", "ha", "hasta", "hay", "la", "las", "le", "les",
  "lo", "los", "mas", "me", "mi", "mis", "mucho", "muy", "nada", "ni", "no", "nos", "nosotros", "o", "os", "otra",
  "otras", "otro", "otros", "para", "pero", "poco", "por", "porque", "puede", "pueden", "que", "quien", "quienes",
  "se", "ser", "sin", "sobre", "son", "su", "sus", "tambien", "te", "tiene", "tienen", "todo", "todos", "tu", "tus",
  "un", "una", "unas", "uno", "unos", "y", "ya",
  // Question scaffolding: it shapes the question, not the passages that answer it.
  "according", "compare", "compares", "context", "describe", "describes",
  "difference", "differences", "explain", "explains", "mean", "meaning", "means", "relate", "related", "relates",
  "relationship", "tell",
  "comparar", "comparacao", "conexao", "conexoes", "contexto", "descreva", "descrever", "diferenca", "diferencas",
  "explica", "explicar", "relacao", "relaciona", "relacionam", "relacionar", "significa", "significado",
  "comparacion", "conexion", "conexiones", "contexto", "describe", "describir", "diferencia", "diferencias", "explica",
  "explicar", "relacion", "relaciona", "relacionan", "relacionar", "significa", "significado",
]);

const LOW_SIGNAL_LATIN_VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

/** FTS5 expects an expression, not free text; `toFtsPlan(q).primary` is the query to run. */
export function toFtsQuery(q: string): string {
  return toFtsPlan(q).primary;
}

export function toFtsPlan(q: string, options: FtsPlanOptions = {}): FtsPlan {
  const rawTokens = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  const candidates = informativeTerms(rawTokens);
  if (candidates.length === 0) return { primary: "", terms: 0, rare: 0 };

  const frequency = options.documentFrequency;
  if (!frequency) {
    // Pure planner without corpus access (tests and the legacy helper): OR of the terms.
    const selected = selectByLength(candidates);
    return { primary: selected.map(render).join(" OR "), terms: selected.length, rare: 0 };
  }

  const withFrequency: Candidate[] = [];
  for (const candidate of candidates) {
    // fts5vocab lists the tokenizer's terms, which are diacritic-stripped (`atencao`,
    // not `atenção`); the query text keeps its accents for FTS, but df must use the key.
    const df = frequency(candidate.key, !candidate.exact);
    if (df <= 0) continue; // absent terms cannot match; never poison the AND.
    withFrequency.push({ ...candidate, df });
  }
  if (withFrequency.length === 0) return { primary: "", terms: 0, rare: 0 };

  const selected = selectByFrequency(withFrequency);
  const totalRows = options.totalRows ?? 0;
  const rareLimit = Math.max(
    1,
    Math.min(
      Math.ceil(totalRows * (options.rareFraction ?? DEFAULT_RARE_FRACTION)),
      options.rareCap ?? DEFAULT_RARE_CAP,
    ),
  );
  const rare = selected.filter((candidate) => (candidate.df ?? 0) <= rareLimit);
  const allAnd = selected.map(render).join(" AND ");
  const rareOr = rare.map(render).join(" OR ");

  // The fallback is allowed only when there is no rare term at all and the AND is empty.
  // With rare terms, common terms never enter an OR; the rare union is the recall pass.
  const fallback = rare.length === 0 && selected.length > 1
    ? [...selected]
      .sort((left, right) => (left.df ?? 0) - (right.df ?? 0) || right.key.length - left.key.length || left.order - right.order)
      .slice(0, 3)
      .map(render)
      .join(" OR ")
    : undefined;

  let primary: string;
  if (selected.length === 1) {
    primary = render(selected[0]!);
  } else if (rare.length === 0) {
    primary = allAnd;
  } else if (rare.length === selected.length) {
    // Every term is rare: the AND is subsumed by the OR, so keep the cheaper exact union.
    primary = rareOr;
  } else {
    primary = `(${allAnd}) OR (${rareOr})`;
  }
  return { primary, fallback, terms: selected.length, rare: rare.length };
}

/**
 * Keeps at most `MAX_TERMS`, in the original order. Significant short terms and numbers
 * are preserved before the longest regular terms fill the remaining slots.
 */
function selectByLength(candidates: readonly Candidate[]): Candidate[] {
  const protectedTerms = candidates.filter((candidate) => candidate.protectedTerm);
  const regular = candidates
    .filter((candidate) => !candidate.protectedTerm)
    .sort((left, right) => right.key.length - left.key.length || left.order - right.order);
  return choose([...protectedTerms, ...regular], candidates);
}

/**
 * Rare terms first for the AND selection; protected short terms survive even when they
 * are common, but they never enter the standalone rare OR unless their df is low.
 */
function selectByFrequency(candidates: readonly Candidate[]): Candidate[] {
  const protectedTerms = candidates.filter((candidate) => candidate.protectedTerm);
  const regular = candidates
    .filter((candidate) => !candidate.protectedTerm)
    .sort((left, right) => (left.df ?? 0) - (right.df ?? 0) || right.key.length - left.key.length || left.order - right.order);
  return choose([...protectedTerms, ...regular], candidates);
}

function choose(ordered: readonly Candidate[], candidates: readonly Candidate[]): Candidate[] {
  const chosen = new Set<Candidate>();
  for (const candidate of ordered) {
    if (chosen.size >= MAX_TERMS) break;
    chosen.add(candidate);
  }
  return candidates.filter((candidate) => chosen.has(candidate));
}

function informativeTerms(rawTokens: readonly string[]): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let singleCharTerms = 0;
  for (const [order, raw] of rawTokens.entries()) {
    const text = raw.toLowerCase();
    const key = stripDiacritics(text);
    if (seen.has(key)) continue;
    if (text.length === 1) {
      if (!isSignificantSingleChar(raw) || singleCharTerms >= SINGLE_CHAR_TERM_LIMIT) continue;
      singleCharTerms += 1;
    } else if (isStopword(key)) {
      continue;
    }
    seen.add(key);
    const numeric = /^\p{Nd}+$/u.test(text);
    const exact = numeric || text.length < PREFIX_MIN_CHARS;
    candidates.push({ text, key, exact, protectedTerm: exact, order });
  }
  return candidates;
}

/** Digits, non-Latin single characters and uppercase Latin consonants name real things. */
function isSignificantSingleChar(raw: string): boolean {
  if (!/\p{Script=Latin}/u.test(raw)) return true;
  if (!/\p{Lu}/u.test(raw)) return false;
  const letter = stripDiacritics(raw.toLowerCase());
  return !LOW_SIGNAL_LATIN_VOWELS.has(letter);
}

/** Stopword comparison is accent-insensitive (`não`/`nao`, `más`/`mas`). */
function isStopword(key: string): boolean {
  return STOPWORDS.has(key);
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function render(candidate: Candidate): string {
  const quoted = `"${candidate.text.replaceAll('"', '""')}"`;
  return candidate.exact ? quoted : `${quoted}*`;
}
