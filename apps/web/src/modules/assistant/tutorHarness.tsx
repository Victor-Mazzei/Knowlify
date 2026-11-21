import { useMemo } from "react";
import type { ReactNode } from "react";
import { MemoryRouter, useParams } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import type { Credentials } from "../../types";
import { ChatStatusContext } from "./useChatStatus";
import type { ChatStatusState } from "./useChatStatus";
import { TutorDock } from "./TutorDock";
import { TutorProvider, useRegisterTutorContext, useTutor } from "./TutorProvider";
import type { ChatStatus } from "./types";

const credentials: Credentials = { user: "reader", pass: "secret" };

const encoder = new TextEncoder();

/** A complete SSE answer, for tests that only need the request and the final text. */
export function eventResponse(events: unknown[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** A stream the test drives event by event, with abort wired to the request signal. */
export function controlledStream() {  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response(signal?: AbortSignal | null) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          /* already closed */
        }
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
    emit(event: unknown) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export const tutorChatStatus = (overrides: Partial<ChatStatus> = {}): ChatStatus => ({
  enabled: true,
  model: "deepseek-v4.1-flash",
  host: "api.example.test",
  promptVersion: "feynman-2",
  scopes: { library: true, book: true },
  ...overrides,
});

export const chatStatusContext = (status: ChatStatus | null, loading = false): ChatStatusState => ({
  status,
  loading,
  enabled: status?.enabled ?? false,
  refresh: async () => undefined,
});

export function TutorTestProviders({
  api,
  status = tutorChatStatus(),
  initialEntries = ["/"],
  children,
}: {
  api: ApiFn;
  status?: ChatStatus | null;
  initialEntries?: string[];
  children: ReactNode;
}) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <ChatStatusContext.Provider value={chatStatusContext(status)}>
        <TutorProvider credentials={credentials} onLogout={() => undefined} api={api}>
          <div id="tutor-main">{children}</div>
          <TutorDock />
        </TutorProvider>
      </ChatStatusContext.Provider>
    </MemoryRouter>
  );
}

/** Mirrors ReaderBody's wiring for tests that need a book context on a reader route. */
export function ReaderProbe({ bookId, title, page = 7, section = "Chapter 2" }: { bookId?: string; title?: string; page?: number; section?: string }) {
  const params = useParams();
  const tutor = useTutor();
  const id = bookId ?? params.id ?? "b1";
  const context = useMemo(
    () => ({
      book: { id, title: title ?? `Book ${id}` },
      page,
      section,
      visibleText: () => "The page on screen.",
    }),
    [id, title, page, section],
  );
  useRegisterTutorContext(context);
  return (
    <div>
      <p>{title ?? `Book ${id}`}</p>
      <button id="tutor-reader-toggle" type="button" onClick={tutor.toggleTutor}>
        Reader tutor
      </button>
      <button
        type="button"
        onClick={() =>
          tutor.askAbout({ text: "A selected passage.", kind: "selection", page, section })
        }
      >
        Ask selection
      </button>
    </div>
  );
}
