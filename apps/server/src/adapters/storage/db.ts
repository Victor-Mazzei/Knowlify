import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  // WAL with NORMAL never corrupts the database; a power loss may drop the last commit.
  // The library is reindexable and reading progress is written again on the next save.
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
  // 64 MiB is a deliberate cap: a 200k-chunk lab measured no gain above SQLite's default
  // 2 MiB for search (the OS page cache serves the index), so the process memory stays
  // predictable even with a 6.7 GB database.
  db.pragma("cache_size = -65536");
  db.pragma("wal_autocheckpoint = 2000");
  db.pragma("journal_size_limit = 67108864");
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      format TEXT NOT NULL,
      path TEXT NOT NULL,
      cover_path TEXT,
      size INTEGER NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS kosync_progress (
      document TEXT PRIMARY KEY,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL,
      device TEXT NOT NULL,
      device_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      quote TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- No foreign key on purpose: notes survive a book vanishing from a library folder.
    CREATE INDEX IF NOT EXISTS notes_book ON notes(book_id, created_at);
    CREATE TABLE IF NOT EXISTS web_progress (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      percentage REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const cols = (db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("source_id")) db.exec("ALTER TABLE books ADD COLUMN source_id TEXT");
  if (!cols.includes("mtime")) db.exec("ALTER TABLE books ADD COLUMN mtime INTEGER");
  if (!cols.includes("status")) db.exec("ALTER TABLE books ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS books_path ON books(path)");
  db.exec("CREATE INDEX IF NOT EXISTS books_source ON books(source_id)");
  // v1: PDFs indexed before cover rendering existed get reprocessed once, in the background.
  if ((db.pragma("user_version", { simple: true }) as number) < 1) {
    db.exec("UPDATE books SET status = 'pending' WHERE format = 'pdf' AND cover_path IS NULL");
    db.pragma("user_version = 1");
  }
  if ((db.pragma("user_version", { simple: true }) as number) < 2) {
    db.transaction(() => {
      db.exec(`CREATE TABLE feeds (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        query TEXT, enabled INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, link TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL, summary TEXT NOT NULL, publishedAt TEXT, savedAt INTEGER NOT NULL
      );`);
      db.pragma("user_version = 2");
    })();
  }
  if ((db.pragma("user_version", { simple: true }) as number) < 3) {
    db.transaction(() => {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.pragma("user_version = 3");
    })();
  }
  if ((db.pragma("user_version", { simple: true }) as number) < 4) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS book_index (
          book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK (state IN ('pending','indexing','ready','error')),
          priority INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT,
          index_version TEXT,
          fingerprint TEXT,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          requested_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS book_index_queue ON book_index(state, priority DESC, requested_at);
        CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY,
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          text TEXT NOT NULL,
          page INTEGER,
          section TEXT,
          UNIQUE (book_id, ordinal)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          content='chunks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TABLE IF NOT EXISTS chunk_vectors (
          chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
          book_id TEXT NOT NULL,
          vec BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chunk_vectors_book ON chunk_vectors(book_id);
      `);
      db.pragma("user_version = 4");
    })();
  }
  if ((db.pragma("user_version", { simple: true }) as number) < 5) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('library','book')),
          book_id TEXT,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK ((scope_kind = 'book') = (book_id IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS conversations_scope ON conversations(scope_kind, book_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content TEXT NOT NULL,
          citations_json TEXT,
          prompt_version TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (conversation_id, seq)
        );
      `);
      db.pragma("user_version = 5");
    })();
  }
  // v6: keyset ordering and queue/status lookups (ADR-D1). Index-only migration: no
  // column or table changes, so it is safe to roll back by dropping the indexes.
  if ((db.pragma("user_version", { simple: true }) as number) < 6) {
    db.transaction(() => {
      // Both columns share the sort direction so a forward or backward index scan
      // serves added asc/desc without a temporary B-tree.
      db.exec(`
        CREATE INDEX IF NOT EXISTS books_added ON books(added_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS books_title ON books(title COLLATE NOCASE, id);
        CREATE INDEX IF NOT EXISTS books_pending ON books(status) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS book_index_state ON book_index(state);
      `);
      // One-time statistics refresh; builds the planner's sqlite_stat1 for the new indexes.
      db.exec("ANALYZE");
      db.pragma("user_version = 6");
    })();
  }
  // v7: filter/sort indexes for the library list. Index-only migration: no column or table
  // changes, so rollback is just dropping the indexes.
  if ((db.pragma("user_version", { simple: true }) as number) < 7) {
    db.transaction(() => {
      // Same direction on both columns so the lastRead and author keysets scan the index
      // forward or backward instead of building a temporary B-tree.
      db.exec(`
        CREATE INDEX IF NOT EXISTS web_progress_updated ON web_progress(updated_at DESC, book_id DESC);
        CREATE INDEX IF NOT EXISTS books_author ON books(author COLLATE NOCASE, id);
        CREATE INDEX IF NOT EXISTS books_source_added ON books(source_id, added_at DESC, id DESC);
      `);
      db.exec("ANALYZE");
      db.pragma("user_version = 7");
    })();
  }
  // v8: content identity by full-file hash plus the alias/merge bookkeeping. Additive only:
  // an older build opens the database and ignores the new objects. Rollback is dropping the
  // table/indexes (the column is simply left unused).
  if ((db.pragma("user_version", { simple: true }) as number) < 8) {
    db.transaction(() => {
      const columns = (db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes("content_hash")) db.exec("ALTER TABLE books ADD COLUMN content_hash TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS books_size ON books(size);
        CREATE INDEX IF NOT EXISTS books_content_hash ON books(content_hash) WHERE content_hash IS NOT NULL;
        CREATE TABLE IF NOT EXISTS book_duplicates (
          path TEXT PRIMARY KEY,
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          source_id TEXT,
          size INTEGER NOT NULL,
          mtime INTEGER,
          content_hash TEXT NOT NULL,
          detected_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS book_duplicates_book ON book_duplicates(book_id);
        CREATE INDEX IF NOT EXISTS book_duplicates_source ON book_duplicates(source_id);
        CREATE TABLE IF NOT EXISTS book_merge_log (
          id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          duplicate_id TEXT NOT NULL,
          duplicate_path TEXT NOT NULL,
          source_id TEXT,
          content_hash TEXT NOT NULL,
          note_ids_json TEXT NOT NULL,
          progress_json TEXT,
          merged_at INTEGER NOT NULL
        );
      `);
      db.exec("ANALYZE");
      db.pragma("user_version = 8");
    })();
  }
  // v9: user tags, their book links and the ignored-books tombstone list (ADR-4/ADR-5).
  // Additive: an older build opens the database and ignores the new tables; rollback is
  // dropping book_tags, tags and ignored_books and setting user_version back to 8.
  if ((db.pragma("user_version", { simple: true }) as number) < 9) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          color TEXT NOT NULL CHECK (color IN ('gray','red','orange','amber','green','teal','blue','violet','pink')),
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS tags_name_key ON tags(name_key);
        CREATE TABLE IF NOT EXISTS book_tags (
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (book_id, tag_id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS book_tags_tag ON book_tags(tag_id, book_id);
        CREATE TABLE IF NOT EXISTS ignored_books (
          id TEXT PRIMARY KEY,
          path TEXT,
          source_id TEXT,
          content_hash TEXT,
          size INTEGER NOT NULL,
          title TEXT NOT NULL,
          author TEXT NOT NULL DEFAULT '',
          format TEXT NOT NULL,
          managed INTEGER NOT NULL DEFAULT 0,
          ignored_at INTEGER NOT NULL,
          CHECK (path IS NOT NULL OR content_hash IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ignored_books_path ON ignored_books(path) WHERE path IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ignored_books_hash ON ignored_books(content_hash) WHERE content_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ignored_books_size ON ignored_books(size);
        CREATE INDEX IF NOT EXISTS ignored_books_at ON ignored_books(ignored_at DESC, id DESC);
      `);
      db.exec("ANALYZE");
      db.pragma("user_version = 9");
    })();
  }
  // v10: notes grouped by book (covering index) and MCP access tokens (ADR-4). Additive:
  // an older build opens the database and ignores the new objects. Rollback is dropping
  // mcp_tokens and notes_book_updated and setting user_version back to 9.
  if ((db.pragma("user_version", { simple: true }) as number) < 10) {
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS notes_book_updated ON notes(book_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS mcp_tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL CHECK (scope IN ('read','write_notes')),
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS mcp_tokens_prefix ON mcp_tokens(token_prefix) WHERE revoked_at IS NULL;
      `);
      db.pragma("user_version = 10");
    })();
  }
  // v11: favorites, the file-side metadata snapshot and user overrides (ADR-1/ADR-2).
  // Additive: an older build opens the database and ignores the new columns, table and
  // index. Rollback is dropping books_favorite_added and book_metadata_overrides and
  // setting user_version back to 10; the new columns can stay unused (the next rescan
  // rewrites title/author/cover_path from the file). The backfill copies the current
  // effective values into file_* once, so a v10 library keeps its existing titles.
  if ((db.pragma("user_version", { simple: true }) as number) < 11) {
    db.transaction(() => {
      const columns = (db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes("favorite")) db.exec("ALTER TABLE books ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
      if (!columns.includes("file_title")) db.exec("ALTER TABLE books ADD COLUMN file_title TEXT");
      if (!columns.includes("file_author")) db.exec("ALTER TABLE books ADD COLUMN file_author TEXT");
      if (!columns.includes("file_cover_path")) db.exec("ALTER TABLE books ADD COLUMN file_cover_path TEXT");
      if (!columns.includes("cover_rev")) db.exec("ALTER TABLE books ADD COLUMN cover_rev INTEGER");
      // The file snapshot starts as a copy of the effective values already stored. From
      // here on the repository's UPSERT/UPDATE_METADATA keeps it current (ADR-2).
      db.exec("UPDATE books SET file_title = title, file_author = author, file_cover_path = cover_path");
      db.exec(`
        CREATE TABLE IF NOT EXISTS book_metadata_overrides (
          book_id      TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
          title        TEXT,
          author       TEXT,
          description  TEXT,
          isbn10       TEXT CHECK (isbn10 IS NULL OR length(isbn10) = 10),
          isbn13       TEXT CHECK (isbn13 IS NULL OR length(isbn13) = 13),
          year         INTEGER CHECK (year IS NULL OR year BETWEEN 1 AND 9999),
          publisher    TEXT,
          language     TEXT,
          series       TEXT,
          series_index REAL,
          cover_path   TEXT,
          source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','googlebooks','openlibrary')),
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS books_favorite_added ON books(added_at DESC, id DESC) WHERE favorite = 1;
      `);
      db.exec("ANALYZE");
      db.pragma("user_version = 11");
    })();
  }
  return db;
}
