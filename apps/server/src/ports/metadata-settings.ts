/**
 * Persistence of the metadata lookup settings (`settings` table). `lookupEnabled`
 * is `null` when the user never overrode `KNOWLIFY_METADATA_LOOKUP`; `sealedKey` is
 * the AES-GCM envelope, never the plaintext key.
 */
export interface StoredMetadataSettings {
  lookupEnabled: boolean | null;
  sealedKey: string | null;
}

/** One row with both values; a null field means "no user override". */
export interface MetadataConfigStore {
  load(): StoredMetadataSettings;
  /** Writes both values in one transaction; null removes the corresponding key. */
  save(settings: StoredMetadataSettings): void;
}
