import { Link } from "react-router-dom";
import type { MetadataLookupError, MetadataLookupStatus } from "../types";
import {
  hasLookupTrouble,
  lookupKeyConfigured,
  metadataLookupMessage,
  mostActionableLookupError,
  type LookupMessage,
} from "./lookupMessages";

function Sentence({ message }: { message: LookupMessage }) {
  if (!message.link) return <>{message.text}</>;
  const at = message.text.indexOf(message.link.label);
  if (at < 0) return <>{message.text}</>;
  return (
    <>
      {message.text.slice(0, at)}
      <Link to={message.link.to}>{message.link.label}</Link>
      {message.text.slice(at + message.link.label.length)}
    </>
  );
}

/**
 * Provider failures next to the candidates. With candidates every failure is a note;
 * without candidates the most actionable one becomes the main explanation.
 */
export function ProviderProblems({
  errors,
  status,
  showAll,
}: {
  errors: MetadataLookupError[];
  status: MetadataLookupStatus | null;
  showAll: boolean;
}) {
  if (errors.length === 0) return null;
  const primary = mostActionableLookupError(errors);
  if (!primary) return null;
  const shown = showAll ? errors : [primary];
  return (
    <div className="metadata-provider-feedback" role="status" aria-live="polite">
      {showAll ? (
        <ul className="metadata-provider-notes" aria-label="Provider problems">
          {shown.map((problem, index) => (
            <li key={`${problem.source}:${problem.code}:${problem.reason ?? "none"}:${index}`}>
              <Sentence
                message={metadataLookupMessage(problem, {
                  keyConfigured: lookupKeyConfigured(status, problem.source),
                })}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata-provider-primary">
          <Sentence
            message={metadataLookupMessage(primary, {
              keyConfigured: lookupKeyConfigured(status, primary.source),
            })}
          />
        </p>
      )}
      {hasLookupTrouble(errors) && (
        <p className="metadata-debug-hint">
          For details, set <code>KNOWLIFY_LOG_LEVEL=debug</code> on the server and check the logs.
        </p>
      )}
    </div>
  );
}
