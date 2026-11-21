import type { ApiFn } from "../../components/dialogs";
import { mockChatApi } from "./mockChat";

/**
 * The chat surfaces share one API switch: `VITE_MOCK_CHAT=1` in dev swaps in the
 * in-memory mock without touching `services/api` (used by every other module).
 */
export function chatApi(api: ApiFn): ApiFn {
  return import.meta.env.DEV && import.meta.env.VITE_MOCK_CHAT === "1" ? mockChatApi : api;
}
