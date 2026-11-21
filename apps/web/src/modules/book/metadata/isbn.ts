/** ISBN helpers shared by the manual edit form and the external-candidate panel. */

/** Removes the separators readers usually type; `x` becomes the ISBN-10 check digit. */
export function normalizeIsbn(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidIsbn10(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const character = isbn[index] ?? "";
    const digit = character === "X" ? 10 : Number(character);
    sum += (10 - index) * digit;
  }
  return sum % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    sum += Number(isbn[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

export type IsbnKind = "isbn10" | "isbn13";

export function isbnKind(value: string): IsbnKind | null {
  const isbn = normalizeIsbn(value);
  if (isValidIsbn13(isbn)) return "isbn13";
  if (isValidIsbn10(isbn)) return "isbn10";
  return null;
}

/** First usable ISBN of a detail, preferring the 13-digit form (matches lookup). */
export function preferredIsbn(metadata: {
  isbn10: string | null;
  isbn13: string | null;
}): { kind: IsbnKind; value: string } | null {
  if (metadata.isbn13 && isValidIsbn13(metadata.isbn13)) {
    return { kind: "isbn13", value: normalizeIsbn(metadata.isbn13) };
  }
  if (metadata.isbn10 && isValidIsbn10(metadata.isbn10)) {
    return { kind: "isbn10", value: normalizeIsbn(metadata.isbn10) };
  }
  return null;
}
