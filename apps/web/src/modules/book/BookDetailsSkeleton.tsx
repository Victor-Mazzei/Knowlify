/**
 * Same box model as the loaded page: the cover reserves its 2:3 frame, the
 * breadcrumb line keeps its height and the text lines keep theirs, so switching
 * between the skeleton and the book does not move the content below it.
 */
export function BookDetailsSkeleton() {
  return (
    <main className="book-details" aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading book…
      </p>
      <div aria-hidden="true">
        <span className="book-details-skeleton-line is-crumb" />
        <div className="book-details-skeleton">
          <span className="book-details-skeleton-cover" />
          <div className="book-details-skeleton-body">
            <span className="book-details-skeleton-line is-title" />
            <span className="book-details-skeleton-line is-author" />
            <span className="book-details-skeleton-line is-action" />
            <span className="book-details-skeleton-line is-facts" />
            <span className="book-details-skeleton-line is-paragraph" />
            <span className="book-details-skeleton-line is-paragraph short" />
          </div>
        </div>
      </div>
    </main>
  );
}
