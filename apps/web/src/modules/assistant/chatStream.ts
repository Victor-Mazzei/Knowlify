import type { ApiFn } from "../../components/dialogs";
import { streamFor } from "../../services/api";

/** Decoded text chunks of one chat stream. */
export type ChatStream = {
  read(): Promise<{ done: boolean; value?: string }>;
  cancel(): Promise<void>;
};

/**
 * Opens the SSE response and returns text chunks. WebKit 26.x uses the XHR
 * transport registered on `api`; every other engine keeps fetch + ReadableStream.
 */
export async function openChatStream(api: ApiFn, path: string, init: RequestInit): Promise<ChatStream> {
  const xhr = streamFor(api);
  if (xhr) return xhr(path, init);

  const response = await api(path, init);
  if (!response.body) throw new Error("This browser cannot stream the answer. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  return {
    async read() {
      if (finished) return { done: true };
      const { done, value } = await reader.read();
      if (!done) return { done: false, value: decoder.decode(value, { stream: true }) };
      finished = true;
      const tail = decoder.decode();
      return tail ? { done: false, value: tail } : { done: true };
    },
    cancel: () => reader.cancel(),
  };
}
