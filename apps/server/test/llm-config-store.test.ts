import { describe, expect, it } from "vitest";
import { AesGcmSecretBox } from "../src/adapters/security/SecretBox.js";
import { openDb } from "../src/adapters/storage/db.js";
import { SqliteLlmConfigStore } from "../src/adapters/storage/SqliteSettingsRepository.js";
import { serializeLlmConfig, normalizeLlmConfig } from "../src/domain/assistant/LlmConfig.js";

const SECRET = "s".repeat(32);

describe("SqliteLlmConfigStore", () => {
  it("round-trips config, key and sealed headers in one row set", () => {
    const db = openDb(":memory:");
    try {
      const store = new SqliteLlmConfigStore(db);
      const box = new AesGcmSecretBox(SECRET);
      const config = normalizeLlmConfig({
        url: "https://api.example.com/v1",
        model: "m",
        apiStyle: "anthropic",
        headerNames: ["X-Session-Id"],
      });
      store.save({
        configJson: serializeLlmConfig(config),
        sealedKey: box.seal("sk-key"),
        sealedHeaders: box.seal(JSON.stringify({ "X-Session-Id": "value" })),
      });
      const loaded = store.load();
      expect(loaded?.configJson).toBe(serializeLlmConfig(config));
      expect(loaded?.sealedKey).toMatch(/^v1:/);
      expect(loaded?.sealedHeaders).toMatch(/^v1:/);

      // clearKey keeps the headers; the next load can still send them.
      store.clearKey();
      expect(store.load()).toMatchObject({ sealedKey: null });
      expect(store.load()?.sealedHeaders).toMatch(/^v1:/);

      // clear drops everything, including the custom headers.
      store.clear();
      expect(store.load()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("removes the header blob when a save has none", () => {
    const db = openDb(":memory:");
    try {
      const store = new SqliteLlmConfigStore(db);
      const config = normalizeLlmConfig({ url: "https://api.example.com/v1" });
      store.save({
        configJson: serializeLlmConfig(config),
        sealedKey: null,
        sealedHeaders: "v1:old",
      });
      store.save({
        configJson: serializeLlmConfig(config),
        sealedKey: null,
        sealedHeaders: null,
      });
      expect(store.load()?.sealedHeaders).toBeNull();
    } finally {
      db.close();
    }
  });
});
