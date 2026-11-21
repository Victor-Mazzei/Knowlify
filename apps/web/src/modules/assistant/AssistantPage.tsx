import { useChatStatusContext } from "./useChatStatus";

/**
 * `/ask` is the tutor's full workspace. The conversation itself lives in the
 * persistent tutor panel (mounted above the routes) and is rendered into this
 * page, so moving between the drawer and this page never restarts a stream.
 */
export function AssistantPage() {
  const { status, loading } = useChatStatusContext();
  if (loading && !status) {
    return (
      <main className="asst-page solo">
        <p className="muted loading">Checking chat…</p>
      </main>
    );
  }
  if (status?.enabled && status.scopes.library) {
    return (
      <main className="tutor-page-shell">
        <div id="tutor-slot-page" className="tutor-page-host" />
      </main>
    );
  }
  return (
    <main className="asst-page solo">
      <section className="asst-main" aria-label="Chat">
        {status?.enabled ? (
          <div className="empty">
            <strong>Library chat isn&apos;t available.</strong>
            <span>
              Turn on the search index in Settings to ask across your library. You can still ask about a
              book from its reader.
            </span>
          </div>
        ) : (
          <div className="empty">
            <strong>Chat isn&apos;t available.</strong>
            <span>This server isn&apos;t configured with a language model.</span>
          </div>
        )}
      </section>
    </main>
  );
}
