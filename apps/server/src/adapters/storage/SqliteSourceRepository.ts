import type { Db } from "./db.js";
import type { Source, SourceRepository } from "../../ports/index.js";

export class SqliteSourceRepository implements SourceRepository {
  constructor(private db: Db) {}
  list(): Source[] { return this.db.prepare("SELECT * FROM sources ORDER BY path").all() as Source[]; }
  byPath(path: string) { return this.db.prepare("SELECT * FROM sources WHERE path = ?").get(path) as Source | undefined; }
  save(source: Source): void { this.db.prepare("INSERT INTO sources (id,path) VALUES (@id,@path)").run(source); }
  delete(id: string): boolean { return this.db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0; }
}

