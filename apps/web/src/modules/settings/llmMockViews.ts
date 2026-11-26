import { LLM_DEFAULT_LIMITS, type LlmApiStyle, type LlmHeaderView, type LlmSettingsView } from "./llmTypes";
import { customPrompt, defaultPrompt } from "./llmPromptMock";

export const MOCK_LLM_SCENARIOS = [
  "empty",
  "configured",
  "custom-prompt",
  "env",
  "env-locked",
  "models-ok",
  "models-unsupported",
  "blocked",
  "unauthorized",
  "rate-limited",
  "key-unreadable",
  "headers",
  "headers-unreadable",
  "anthropic",
  "local_only",
] as const;

export type MockLlmScenario = (typeof MOCK_LLM_SCENARIOS)[number];

export type MockView = LlmSettingsView &
  Required<Pick<LlmSettingsView, "apiStyle" | "headers" | "headersState">>;

export type SavedHeader = { name: string; value: string };

const OPENAI_MODELS = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4.1-flash", "llama3.1"];
const ANTHROPIC_MODELS = ["claude-sonnet-5-5", "claude-opus-5", "claude-haiku-4-5"];

const savedHeader = (name: string, value: string): [string, SavedHeader] => [
  name.toLowerCase(),
  { name, value },
];

const configuredHeaders = () =>
  new Map<string, SavedHeader>([savedHeader("x-session-id", "conversation-42")]);

export const envHeaders = () => new Map<string, SavedHeader>([savedHeader("x-tenant", "environment")]);

export const viewHeaders = (values: Map<string, SavedHeader>): LlmHeaderView[] =>
  [...values.values()].map(({ name, value }) => ({ name, hasValue: Boolean(value) }));

export const modelsFor = (style: LlmApiStyle) =>
  style === "anthropic" ? ANTHROPIC_MODELS : OPENAI_MODELS;

const envView = (): MockView => ({
  source: "env",
  locked: false,
  enabled: true,
  url: "http://localhost:11434/v1",
  model: "llama3.1",
  hasKey: false,
  keyState: "none",
  ...LLM_DEFAULT_LIMITS,
  defaults: { ...LLM_DEFAULT_LIMITS },
  policy: { allowPrivate: "on", publicRequiresHttps: true },
  prompt: defaultPrompt(),
  apiStyle: "openai",
  headers: viewHeaders(envHeaders()),
  headersState: "set",
});

const dbView = (overrides: Partial<MockView> = {}): MockView => ({
  ...envView(),
  source: "db",
  url: "https://api.deepseek.com/v1",
  model: "deepseek-v4.1-flash",
  hasKey: true,
  keyState: "set",
  policy: { allowPrivate: "off", publicRequiresHttps: true },
  headers: [],
  headersState: "none",
  ...overrides,
});

export const initialHeaders = (scenario: MockLlmScenario): Map<string, SavedHeader> => {
  if (scenario === "env" || scenario === "env-locked") return envHeaders();
  if (scenario === "headers") return configuredHeaders();
  if (scenario === "anthropic") {
    return new Map([savedHeader("anthropic-version", "2026-10-21")]);
  }
  return new Map();
};

export function initialLlmView(scenario: MockLlmScenario): MockView {
  if (scenario === "empty") {
    return {
      ...envView(),
      source: "none",
      enabled: false,
      url: null,
      model: null,
      hasKey: false,
      keyState: "none",
      ...LLM_DEFAULT_LIMITS,
      headers: [],
      headersState: "none",
    };
  }
  if (scenario === "env" || scenario === "env-locked") {
    const locked = scenario === "env-locked";
    return { ...envView(), locked, prompt: { ...defaultPrompt(), locked } };
  }
  if (scenario === "custom-prompt") return dbView({ prompt: customPrompt() });
  if (scenario === "key-unreadable") return dbView({ enabled: false, hasKey: false, keyState: "unreadable" });
  if (scenario === "headers-unreadable") {
    return dbView({
      enabled: false,
      headers: [{ name: "x-session-id", hasValue: true }],
      headersState: "unreadable",
    });
  }
  if (scenario === "headers") {
    return dbView({ headers: viewHeaders(configuredHeaders()), headersState: "set" });
  }
  if (scenario === "anthropic") {
    return dbView({
      url: "https://api.anthropic.com",
      model: "claude-sonnet-5-5",
      apiStyle: "anthropic",
      headers: [{ name: "anthropic-version", hasValue: true }],
    });
  }
  return dbView();
}
