import { useEffect, useRef } from "react";
import { AnswerText, Sources } from "./Citations";
import { Spinner } from "./Spinner";
import type { ChatMessage } from "./types";

export function MessageList({
  messages,
  streaming,
  examples,
  emptyTitle,
  emptyCopy,
  onExample,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  examples: string[];
  emptyTitle: string;
  emptyCopy?: string;
  onExample: (question: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages, streaming]);

  if (messages.length === 0) {
    return (
      <div className="asst-empty">
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
    );
  }

  return (
    <div className="asst-turns" role="log" aria-live="polite" aria-relevant="additions text">
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
              {message.content ? <AnswerText text={message.content} citations={message.citations} /> : null}
              {live ? <Spinner label="The tutor is answering" inline={Boolean(message.content)} /> : null}
              {message.incomplete ? <p className="asst-incomplete">Answer incomplete.</p> : null}
            </div>
            <Sources citations={message.citations} />
          </article>
        );
      })}
      <div ref={end} aria-hidden="true" />
    </div>
  );
}
