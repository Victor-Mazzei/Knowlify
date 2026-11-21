import type { ApiFn } from "../../components/dialogs";
import { mockDuplicateUpload } from "../duplicates/mockDuplicatesApi";
import { createMockBooks, mockBooksApi } from "../library/mockBooksApi";
import { createMockMetadataApi } from "./metadata/mockMetadataApi";

let devApi: ApiFn | null = null;

const METADATA_ROUTE = /^\/api\/(metadata\/|books\/[^/?]+\/(metadata|cover)(\/|$|\?))/;

/**
 * One in-memory library for every dev-mode page, so favoriting or deleting a
 * book in its details is visible when the Library comes back. The metadata
 * routes (edit, cover, online search) go to their own mock; its edits are not
 * mirrored into the list mock. `null` outside `VITE_MOCK_BOOKS=1`.
 */
export function devBooksApi(): ApiFn | null {
  if (import.meta.env.VITE_MOCK_BOOKS !== "1") return null;
  if (!devApi) {
    const books = createMockBooks();
    const library = mockDuplicateUpload(mockBooksApi(books));
    const metadata = createMockMetadataApi({ books });
    devApi = (path, init) => (METADATA_ROUTE.test(path) ? metadata(path, init) : library(path, init));
  }
  return devApi;
}
