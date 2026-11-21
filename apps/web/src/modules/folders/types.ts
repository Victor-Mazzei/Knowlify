/**
 * HTTP contract types for the read-only folder browser (`GET /api/fs`).
 * Mirrors the `GET /api/fs` contract in
 * docs/planner/2026-11-06-chat-llm-folder-picker-cleanup.md.
 * Keep this module free of server imports and runtime logic.
 */

export type FolderEntry = {
  name: string;
  path: string;
};

export type FolderListing = {
  /** Empty when the server answers with its allowed roots. */
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  books: number;
  /**
   * Additive field: true when the server only exposes configured browse roots.
   * Absent on older servers, which browse the whole filesystem.
   */
  restricted?: boolean;
};
