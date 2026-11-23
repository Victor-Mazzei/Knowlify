import type { SettingsRepository } from "../../ports/account.js";
import type { ChatLimitsStore, LlmConfigStore, StoredLlmSettings, TutorPromptStore } from "../../ports/llm-settings.js";
import type { MetadataConfigStore, StoredMetadataSettings } from "../../ports/metadata-settings.js";
import type { Db } from "./db.js";

const LLM_CONFIG_KEY = "llm_config";
const LLM_API_KEY_KEY = "llm_api_key";
const LLM_HEADERS_KEY = "llm_headers";
const LLM_SYSTEM_PROMPT_KEY = "llm_system_prompt";
const METADATA_LOOKUP_KEY = "metadata_lookup_enabled";
const METADATA_API_KEY_KEY = "metadata_google_books_key";
const CHAT_MAX_CONVERSATIONS_KEY = "chat_max_conversations";

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private db: Db) {}
  get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  set(values: Readonly<Record<string, string>>): void {
    this.db.transaction(() => {
      const statement = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const [key, value] of Object.entries(values)) statement.run(key, value);
    })();
  }
  delete(keys: readonly string[]): void {
    if (keys.length === 0) return;
    this.db.transaction(() => {
      const statement = this.db.prepare("DELETE FROM settings WHERE key = ?");
      for (const key of keys) statement.run(key);
    })();
  }
}

export class SqliteLlmConfigStore implements LlmConfigStore {
  constructor(private db: Db) {}

  load(): StoredLlmSettings | undefined {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
      .all(LLM_CONFIG_KEY, LLM_API_KEY_KEY, LLM_HEADERS_KEY) as { key: string; value: string }[];
    const configJson = rows.find((row) => row.key === LLM_CONFIG_KEY)?.value;
    if (configJson === undefined) return undefined;
    return {
      configJson,
      sealedKey: rows.find((row) => row.key === LLM_API_KEY_KEY)?.value ?? null,
      sealedHeaders: rows.find((row) => row.key === LLM_HEADERS_KEY)?.value ?? null,
    };
  }

  save(settings: StoredLlmSettings): void {
    this.db.transaction(() => {
      const put = this.db.prepare(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      const remove = this.db.prepare("DELETE FROM settings WHERE key = ?");
      put.run(LLM_CONFIG_KEY, settings.configJson);
      if (settings.sealedKey === null) remove.run(LLM_API_KEY_KEY);
      else put.run(LLM_API_KEY_KEY, settings.sealedKey);
      if (settings.sealedHeaders === null) remove.run(LLM_HEADERS_KEY);
      else put.run(LLM_HEADERS_KEY, settings.sealedHeaders);
    })();
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM settings WHERE key IN (?, ?, ?)").run(LLM_CONFIG_KEY, LLM_API_KEY_KEY, LLM_HEADERS_KEY);
    })();
  }

  clearKey(): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(LLM_API_KEY_KEY);
  }
}

/** The metadata lookup toggle and the sealed Google Books key, one row each. */
export class SqliteMetadataConfigStore implements MetadataConfigStore {
  constructor(private db: Db) {}

  load(): StoredMetadataSettings {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
      .all(METADATA_LOOKUP_KEY, METADATA_API_KEY_KEY) as { key: string; value: string }[];
    const enabled = rows.find((row) => row.key === METADATA_LOOKUP_KEY)?.value;
    return {
      lookupEnabled: enabled === "on" ? true : enabled === "off" ? false : null,
      sealedKey: rows.find((row) => row.key === METADATA_API_KEY_KEY)?.value ?? null,
    };
  }

  save(settings: StoredMetadataSettings): void {
    this.db.transaction(() => {
      const put = this.db.prepare(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      const remove = this.db.prepare("DELETE FROM settings WHERE key = ?");
      if (settings.lookupEnabled === null) remove.run(METADATA_LOOKUP_KEY);
      else put.run(METADATA_LOOKUP_KEY, settings.lookupEnabled ? "on" : "off");
      if (settings.sealedKey === null) remove.run(METADATA_API_KEY_KEY);
      else put.run(METADATA_API_KEY_KEY, settings.sealedKey);
    })();
  }
}

/** Separate key from `llm_config`: resetting the provider must not erase the session limit. */
export class SqliteChatLimitsStore implements ChatLimitsStore {
  constructor(private db: Db) {}

  load(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CHAT_MAX_CONVERSATIONS_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  save(value: number | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(CHAT_MAX_CONVERSATIONS_KEY);
      return;
    }
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(CHAT_MAX_CONVERSATIONS_KEY, String(value));
  }
}

/** Separate key from `llm_config`: resetting the provider must not erase the persona. */
export class SqliteTutorPromptStore implements TutorPromptStore {
  constructor(private db: Db) {}

  load(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(LLM_SYSTEM_PROMPT_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  save(text: string | null): void {
    if (text === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(LLM_SYSTEM_PROMPT_KEY);
      return;
    }
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(LLM_SYSTEM_PROMPT_KEY, text);
  }
}
