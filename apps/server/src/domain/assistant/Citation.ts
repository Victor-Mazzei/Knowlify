/** One numbered source behind an assistant answer; `n` is the marker used in the text (`[n]`). */
export interface Citation {
  n: number;
  passageId: number;
  bookId: string;
  bookTitle: string;
  page: number | null;
  section: string | null;
}
