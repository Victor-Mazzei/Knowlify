/**
 * HTTP contract for online metadata lookup (`/api/settings/metadata`).
 * The server never returns the Google Books key, only its state and origin.
 */

export type MetadataLookupSource = "env" | "user";

export type MetadataKeyState = "ok" | "unreadable" | "none";

export type MetadataKeySource = "env" | "user" | "none";

export type MetadataProvider = "openlibrary" | "googlebooks";

export type MetadataSettingsView = {
  lookupEnabled: boolean;
  lookupSource: MetadataLookupSource;
  googleBooks: {
    hasKey: boolean;
    keyState: MetadataKeyState;
    source: MetadataKeySource;
  };
  locked: boolean;
  providers: MetadataProvider[];
};

/** An omitted field keeps its saved value; `null` removes the saved key. */
export type MetadataSettingsSave = {
  lookupEnabled?: boolean;
  googleBooksKey?: string | null;
};

export const METADATA_KEY_MAX = 256;
