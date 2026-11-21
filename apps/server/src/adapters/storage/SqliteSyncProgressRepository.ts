import type { Db } from "./db.js";
import type { StoredSyncedProgress, SyncProgressRepository } from "../../ports/index.js";

export class SqliteSyncProgressRepository implements SyncProgressRepository {
  constructor(private db: Db) {}
  get(document: string) { return this.db.prepare("SELECT document,progress,percentage,device,device_id,timestamp FROM kosync_progress WHERE document = ?").get(document) as StoredSyncedProgress | undefined; }
  save(progress: StoredSyncedProgress): void {
    this.db.prepare(`INSERT INTO kosync_progress (document,progress,percentage,device,device_id,timestamp)
      VALUES (@document,@progress,@percentage,@device,@device_id,@timestamp)
      ON CONFLICT(document) DO UPDATE SET progress=excluded.progress,percentage=excluded.percentage,
      device=excluded.device,device_id=excluded.device_id,timestamp=excluded.timestamp`).run(progress);
  }
}
