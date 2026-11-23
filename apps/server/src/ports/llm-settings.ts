import type { LlmApiStyle } from "../domain/assistant/LlmApiStyle.js";
import type { LlmHeaderStored } from "../domain/assistant/LlmHeaders.js";
import type { LlmClient } from "./assistant.js";

/** Raw rows of `settings` for the LLM context; parsing belongs to the use case. */
export interface StoredLlmSettings {
  configJson: string;
  sealedKey: string | null;
  /** Sealed JSON `{headerName: value}`; `null` means no custom headers. */
  sealedHeaders: string | null;
}

export interface LlmConfigStore {
  load(): StoredLlmSettings | undefined;
  /** Writes config, key and custom headers in one transaction; `null` removes a stored secret. */
  save(settings: StoredLlmSettings): void;
  clear(): void;
  clearKey(): void;
}

/** Editable tutor persona; lives outside the LLM config so resetting one keeps the other. */
export interface TutorPromptStore {
  /** `null` when the user has never customized the persona. */
  load(): string | null;
  /** `null` removes the stored persona and restores the default. */
  save(text: string | null): void;
}

/** Session limit saved by the user; separate from the LLM config so a reset keeps it. */
export interface ChatLimitsStore {
  /** Raw text of the stored integer, or `null` when the user never saved one. */
  load(): string | null;
  /** `null` removes the stored value and restores the environment/default seed. */
  save(value: number | null): void;
}

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export interface LlmRuntimeConfig {
  url: string;
  apiKey: string;
  model: string;
  timeoutSec: number;
  apiStyle: LlmApiStyle;
  headers: readonly LlmHeaderStored[];
  /** UI-provided URLs use the guarded transport; environment URLs keep ADR-12. */
  guard: boolean;
}

/** Swaps the client used by the chat without restarting the process. */
export interface LlmRuntime {
  readonly configured: boolean;
  /** Builds the candidate client and throws on invalid input, without swapping. */
  prepare(config: LlmRuntimeConfig | null): LlmClient;
  /** Swaps synchronously; streams already running keep the previous client. */
  commit(client: LlmClient): void;
}

export type ProbeCode =
  | "blocked"
  | "https_required"
  | "unreachable"
  | "timeout"
  | "tls"
  | "unauthorized"
  | "not_found"
  | "rejected"
  | "key_required";

export interface LlmProbeTarget {
  url: string;
  apiKey: string | null;
  model: string | null;
  apiStyle: LlmApiStyle;
  /** Resolved custom headers for the draft URL (origin rule already applied). */
  headers: readonly LlmHeaderStored[];
}

export interface LlmModelsResult {
  supported: boolean;
  models: string[];
  code?: ProbeCode;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  code?: ProbeCode;
  modelFound?: boolean;
}

export interface LlmEndpointProbe {
  listModels(target: LlmProbeTarget): Promise<LlmModelsResult>;
  testChat(target: LlmProbeTarget): Promise<LlmTestResult>;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;
