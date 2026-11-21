import type { BookIndex } from "../../domain/knowledge/BookIndex.js";
import type { Book, StoredProgress } from "../../ports/index.js";
import type { BookMetadataDetail } from "../../ports/library-metadata.js";
import { toDto } from "./dto.js";

/**
 * `GET /api/books/:id` (ADR-2/ADR-6): the list DTO plus the tag ids and the effective
 * metadata object, so the details page needs one round trip.
 */
export const toBookDetailDto = (
  book: Book,
  metadata: BookMetadataDetail,
  index: BookIndex | undefined,
  indexingEnabled: boolean,
  progress: StoredProgress | undefined,
  tagIds: string[],
) => ({ ...toDto(book, index, indexingEnabled, progress, tagIds), metadata });
