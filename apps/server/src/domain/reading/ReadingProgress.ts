export interface ReadingProgress { position: string; percentage: number }
export interface SyncedProgress { document: string; progress: string; percentage: number; device: string; device_id: string }
export interface StoredSyncedProgress extends SyncedProgress { timestamp: number }
