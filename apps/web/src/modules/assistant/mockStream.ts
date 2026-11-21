import type { ChatEvent } from "./types";

/** Minimal SSE response used by the mock: one `data:` line per event, optional pacing. */
export function eventStream(
  events: ChatEvent[],
  delayMs: number,
  signal: AbortSignal | null | undefined,
  onEvent?: (event: ChatEvent) => void,
) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) {
          stop();
          return;
        }
        signal?.addEventListener("abort", stop, { once: true });
        let index = 0;
        const push = () => {
          if (closed) return;
          if (index >= events.length) {
            closed = true;
            signal?.removeEventListener("abort", stop);
            controller.close();
            return;
          }
          const event = events[index++];
          onEvent?.(event);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          timer = setTimeout(push, delayMs);
        };
        if (delayMs > 0) timer = setTimeout(push, delayMs);
        else push();
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } },
  );
}
