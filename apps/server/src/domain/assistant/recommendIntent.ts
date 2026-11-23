/**
 * Deterministic "does this message ask for book recommendations?" detection (ADR-16).
 * Pure: no I/O and no configuration. A strong match makes the reply itself the
 * recommendation; a weak match (a learning goal) only adds a short book line when a
 * candidate fits. False positives cost one wider search; the explicit control covers
 * false negatives.
 */

export type RecommendFocus = "recommend" | "learn";

export interface RecommendIntent {
  focus: RecommendFocus;
  /** Stable rule id, pinned by tests so a pattern change is always visible. */
  rule: string;
}

/** Acronyms the FTS tokenizer drops but a reader still types as a topic. */
const SHORT_TERMS: ReadonlySet<string> = new Set(["c", "r", "go", "js", "ai", "ml", "qt"]);

/**
 * pt + en + es function words plus the words that express the intent itself, so the
 * retrieval query keeps only the subject. Stored without diacritics: lookups normalize
 * the token before comparing.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Portuguese.
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "por", "para", "pra", "com", "sem", "sobre", "que",
  "qual", "quais", "quem", "como", "onde", "quando", "porque", "porquê", "e", "ou",
  "mas", "se", "ja", "nao", "sim", "muito", "mais", "menos", "tambem", "eu", "voce",
  "ele", "ela", "nos", "eles", "elas", "me", "te", "lhe", "meu", "minha", "seu", "sua",
  "este", "esta", "isso", "isto", "esse", "essa", "aquele", "aquela", "ser", "e", "sao",
  "foi", "era", "estar", "esta", "estou", "tem", "ter", "ha", "posso", "pode", "podem",
  "poderia", "devo", "deve", "quero", "queria", "gostaria", "preciso", "aprender",
  "estudar", "ler", "leitura", "leituras", "livro", "livros", "recomendar", "recomende",
  "recomenda", "recomendacao", "recomendo", "sugere", "sugerir", "indicacao", "indique",
  "indicar", "algum", "alguma", "alguns", "algumas", "tudo", "todo", "toda", "coisa",
  "algo", "bem", "bom", "boa",
  // English.
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "with", "without", "from",
  "by", "about", "as", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "it", "its", "is", "are", "was", "were", "be", "been", "being",
  "am", "do", "does", "did", "can", "could", "should", "would", "will", "shall", "may",
  "might", "must", "have", "has", "had", "i", "you", "he", "she", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "their", "our", "what", "which",
  "who", "whom", "whose", "where", "when", "why", "how", "not", "no", "yes", "some",
  "any", "all", "more", "most", "less", "very", "also", "just", "please", "recommend",
  "recommends", "recommended", "recommending", "suggestion", "suggestions", "suggest",
  "suggests", "book", "books", "read", "reads", "reading", "readings", "learn",
  "learning", "study", "studying", "want", "wants", "need", "needs", "get", "got",
  "start", "started", "starting", "teach", "teaches", "cover", "covers", "help",
  "helps", "best", "good",
  // Spanish.
  "el", "la", "los", "las", "un", "una", "unos", "unas", "del", "al", "en", "por",
  "para", "con", "sin", "sobre", "que", "cual", "cuales", "quien", "como", "donde",
  "cuando", "porque", "y", "o", "pero", "si", "no", "muy", "mas", "menos", "tambien",
  "yo", "tu", "usted", "ella", "nosotros", "ellos", "ellas", "me", "te", "le", "mi",
  "su", "este", "esta", "esto", "ese", "esa", "aquel", "aquella", "ser", "es", "son",
  "fue", "era", "estar", "estoy", "tiene", "tienen", "tener", "haber", "hay", "puedo",
  "puede", "pueden", "podria", "debo", "debe", "quiero", "queria", "gustaria",
  "necesito", "aprender", "estudiar", "leer", "lectura", "lecturas", "libro", "libros",
  "recomendar", "recomiende", "recomienda", "recomendacion", "recomiendo", "sugerir",
  "sugiere", "indicar", "indique", "algun", "alguna", "algunos", "algunas", "todo",
  "toda", "algo", "bien", "bueno", "buena",
]);

const MAX_TERMS = 8;

/** Lowercase, no diacritics, single spaces; punctuation is kept for the patterns. */
export function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const STRONG_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "pt.recommend", pattern: /\brecomend\w*/ },
  { rule: "pt.indicate-books", pattern: /\bindic\w+ (?:um |algum |alguns )?(?:livros?|leituras?)\b/ },
  { rule: "pt.which-book", pattern: /\b(?:que livros?|qual livro)\b/ },
  { rule: "pt.what-to-read", pattern: /\bo que (?:eu )?(?:devo|posso) ler\b/ },
  { rule: "pt.books-about", pattern: /\blivros? (?:sobre|de|para)\b/ },
  { rule: "es.recommend", pattern: /\brecomiend\w*|\brecomend\w*/ },
  { rule: "es.which-book", pattern: /\b(?:que libros?|cual libro)\b/ },
  { rule: "es.what-to-read", pattern: /\bque (?:debo|deberia) leer\b/ },
  { rule: "es.books-about", pattern: /\blibros? (?:sobre|de|para)\b/ },
  { rule: "en.which-books", pattern: /\b(?:which|what) books?\b/ },
  { rule: "en.what-to-read", pattern: /\bwhat (?:should|can) i read\b/ },
  { rule: "en.books-about", pattern: /\bbooks? (?:on|about|for)\b/ },
  { rule: "en.reading-list", pattern: /\breading list\b/ },
];

const WEAK_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "pt.want-to-learn", pattern: /\bquero (?:aprender|estudar)\b/ },
  { rule: "en.where-to-learn", pattern: /\bwhere (?:can|do|should) i learn\b/ },
  { rule: "en.want-to-learn", pattern: /\bi want to (?:learn|study)\b/ },
  { rule: "en.how-to-start", pattern: /\bhow (?:do|can) i (?:start|get started) (?:with|in)\b/ },
  { rule: "es.where-to-learn", pattern: /\bdonde (?:aprendo|puedo aprender)\b/ },
  { rule: "es.want-to-learn", pattern: /\bquiero (?:aprender|estudiar)\b/ },
];

const EN_RECOMMEND = /\b(?:recommend|suggest)\b/;
const EN_BOOK_WORD = /\b(?:books?|reads?|readings?)\b/;

/** Strong beats weak; `null` means the message is a normal question. */
export function detectRecommendIntent(question: string): RecommendIntent | null {
  const text = normalizeIntentText(question);
  if (!text) return null;
  if (EN_RECOMMEND.test(text) && EN_BOOK_WORD.test(text)) {
    return { focus: "recommend", rule: "en.recommend-books" };
  }
  for (const { rule, pattern } of STRONG_RULES) {
    if (pattern.test(text)) return { focus: "recommend", rule };
  }
  for (const { rule, pattern } of WEAK_RULES) {
    if (pattern.test(text)) return { focus: "learn", rule };
  }
  return null;
}

/**
 * Content terms for the retrieval query and the metadata match (ADR-16): no intent
 * words, no pt/en/es stopwords, at least three characters unless the token is one of
 * the short acronyms, at most eight terms in the order the user wrote them. Diacritics
 * are kept because a `LIKE` against a title or author is compared literally; the FTS
 * tokenizer removes them on both sides.
 */
export function recommendationTerms(question: string): string[] {
  const tokens = question.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const plain = token.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (plain.length < 3 && !SHORT_TERMS.has(plain)) continue;
    if (STOPWORDS.has(plain)) continue;
    if (seen.has(plain)) continue;
    seen.add(plain);
    terms.push(token);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}
