import { describe, expect, it } from "vitest";
import {
  detectRecommendIntent,
  normalizeIntentText,
  recommendationTerms,
} from "../src/domain/assistant/recommendIntent.js";

describe("detectRecommendIntent", () => {
  it.each([
    "recomende livros de Rust para web",
    "Quais livros sobre Rust?",
    "qual livro devo ler?",
    "O que devo ler sobre Rust?",
    "indique um livro de Rust",
    "livros para aprender Rust",
    "me recomenda uma leitura de Rust",
  ])("detects a strong Portuguese request: %s", (question) => {
    expect(detectRecommendIntent(question)).toMatchObject({ focus: "recommend" });
  });

  it.each([
    "Recommend books about Rust",
    "Can you suggest a book on Rust?",
    "Which books teach Rust for the web?",
    "What should I read about Rust?",
    "books on Rust",
    "my reading list",
  ])("detects a strong English request: %s", (question) => {
    expect(detectRecommendIntent(question)).toMatchObject({ focus: "recommend" });
  });

  it.each([
    "recomienda libros sobre Rust",
    "¿Qué libros de Rust?",
    "cuál libro debo leer",
    "qué debo leer sobre Rust",
    "libros sobre Rust",
  ])("detects a strong Spanish request: %s", (question) => {
    expect(detectRecommendIntent(question)).toMatchObject({ focus: "recommend" });
  });

  it.each([
    "quero aprender programação Rust para web",
    "quero estudar Rust",
    "where can I learn Rust?",
    "I want to study Rust",
    "How do I get started with Rust?",
    "donde puedo aprender Rust",
    "quiero estudiar Rust",
  ])("detects a weak learning goal: %s", (question) => {
    expect(detectRecommendIntent(question)).toMatchObject({ focus: "learn" });
  });

  it.each([
    "What is a lifetime in Rust?",
    "Explain ownership in Rust",
    "How do I read a PDF?",
    "¿Qué es un préstamo?",
    "compare Python and Rust",
    "what is deep work?",
    "Summarize chapter three",
    "",
  ])("stays quiet for a normal question: %s", (question) => {
    expect(detectRecommendIntent(question)).toBeNull();
  });

  it("strips diacritics and case before matching", () => {
    expect(normalizeIntentText("  RECOMENDAÇÃO de Livros  ")).toBe("recomendacao de livros");
    expect(detectRecommendIntent("RECOMENDAÇÃO DE LIVROS")).toMatchObject({ focus: "recommend" });
  });
});

describe("recommendationTerms", () => {
  it("keeps the subject and drops intent words and stopwords", () => {
    expect(recommendationTerms("quero aprender programação Rust para web"))
      .toEqual(["programação", "rust", "web"]);
    expect(recommendationTerms("recomende livros de Rust para web")).toEqual(["rust", "web"]);
    expect(recommendationTerms("Recommend books about Kubernetes operators"))
      .toEqual(["kubernetes", "operators"]);
  });

  it("keeps the short acronyms the FTS tokenizer drops", () => {
    expect(recommendationTerms("livros de C, R e Go")).toEqual(["c", "r", "go"]);
    expect(recommendationTerms("quero aprender C++ e Qt")).toEqual(["c++", "qt"]);
  });

  it("deduplicates and caps at eight terms in the original order", () => {
    expect(recommendationTerms("Rust rust RUST ownership")).toEqual(["rust", "ownership"]);
    expect(recommendationTerms("alpha beta gamma delta epsilon zeta eta theta iota"))
      .toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]);
  });

  it("keeps the terms of a normal question (detection is a separate decision)", () => {
    expect(recommendationTerms("What is a lifetime in Rust?")).toEqual(["lifetime", "rust"]);
  });
});
