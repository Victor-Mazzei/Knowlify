import { memo, useMemo } from "react";
import type { ApiFn } from "../../components/dialogs";
import { BookSuggestions } from "./BookSuggestions";
import { AnswerText, Sources } from "./Citations";
import { TutorStatus } from "./TutorStatus";
import type { ChatMessage } from "./types";
import { TRANSCRIPT_STYLE } from "./tutorLayout";
import { useStickToBottom } from "./useStickToBottom";

/**
 * One assistant answer. Memoizing at the message boundary means a streaming
 * delta re-parses only the live answer; finished turns keep their DOM and do
 * not re-run Markdown when the list re-renders.
 */
const AssistantAnswer = memo(function AssistantAnswer({
  message,
  live,
  onOpenBook,
}: {
  message: ChatMessage;
  live: boolean;
  onOpenBook?: () => void;
}) {
  const books = useMemo(
    () =>
      message.recommendations
        ? message.recommendations.books.filter((book) => message.recommended?.includes(book.n))
        : undefined,
    [message.recommendations, message.recommended],
  );
  if (!message.content) return null;
  return (
    <AnswerText
      text={message.content}
      citations={message.citations}
      books={books}
      onOpenBook={onOpenBook}
      partial={live || Boolean(message.incomplete)}
    />
  );
});

export function MessageList({
  messages,
  streaming,
  examples,
  emptyTitle,
  emptyCopy,
  onExample,
  api,
  useLibrary = true,
  onEnableLibrary,
  onOpenBook,
  scrollSignal = 0,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  examples: string[];
  emptyTitle: string;
  emptyCopy?: string;
  onExample: (question: string) => void;
  api: ApiFn;
  /** Ask library switch; when off the library-off notice can offer to turn it on. */
  useLibrary?: boolean;
  onEnableLibrary?: () => void;
  onOpenBook?: () => void;
  /** Increments when the person sends or retries: that action always reaches the end. */
  scrollSignal?: number;
}) {
  const { scrollRef, contentRef, onScroll, showJump, jumpToLatest } = useStickToBottom({
    content: messages,
    signal: scrollSignal,
  });

  return (
    <div className="asst-thread" style={TRANSCRIPT_STYLE}>
      <div className="asst-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="asst-empty" ref={contentRef}>
            <h2>{emptyTitle}</h2>
            {emptyCopy && <p>{emptyCopy}</p>}
            <div className="asst-examples">
              {examples.map((question) => (
                <button key={question} type="button" className="asst-example" onClick={() => onExample(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="asst-turns" role="log" aria-live="polite" aria-relevant="additions text" ref={contentRef}>
            {messages.map((message, index) => {
              const live = streaming && index === messages.length - 1 && message.role === "assistant";
              if (message.role === "user") {
                return (
                  <article className="asst-turn" key={message.id}>
                    <p className="asst-turn-label">You</p>
                    <p className="asst-question">{message.content}</p>
                  </article>
                );
              }
              return (
                <article className="asst-turn" key={message.id}>
                  <p className="asst-turn-label">Tutor</p>
                  <div className="asst-answer-wrap" aria-busy={live ? true : undefined}>
                    <AssistantAnswer message={message} live={live} onOpenBook={onOpenBook} />
                    {live ? <TutorStatus phase={message.content ? "writing" : "thinking"} /> : null}
                    {message.incomplete ? <p className="asst-incomplete">Answer incomplete.</p> : null}
                  </div>
                  <Sources citations={message.citations} />
                  {!live && (
                    <BookSuggestions
                      recommendations={message.recommendations}
                      recommended={message.recommended}
                      api={api}
                      useLibrary={useLibrary}
                      onEnableLibrary={onEnableLibrary}
                      onOpenBook={onOpenBook}
                    />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      {showJump && messages.length > 0 && (
        <>
          <p className="asst-visually-hidden" role="status">
            New content below.
          </p>
          <button type="button" className="asst-jump" onClick={jumpToLatest}>
            Jump to latest
          </button>
        </>
      )}
    </div>
  );
}
