import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { RefObject } from "react";
import { formatError } from "../../services/api";
import type { Book, Progress } from "../../types";

export function usePdfReader({
  book,
  data,
  container,
  initialPosition,
  scheduleProgress,
  onError,
}: {
  book: Book;
  data: ArrayBuffer;
  container: RefObject<HTMLDivElement>;
  initialPosition: string;
  scheduleProgress: (progress: Progress) => void;
  onError: (message: string) => void;
}) {
  const loadedPdf = useRef<PDFDocumentProxy>();
  const startPage = useRef(Math.max(1, Number(initialPosition) || 1));
  const visibleTextRef = useRef("");
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(startPage.current);
  const mounted = useRef(true);
  // Latest callbacks without making them effect dependencies: an unstable callback
  // identity must not reload the document or redraw the current page.
  const callbacks = useRef({ scheduleProgress, onError });
  callbacks.current = { scheduleProgress, onError };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (book.format !== "pdf") return;
    let cancelled = false;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const loadingTask = pdfjs.getDocument({ data: data.slice(0) });
    void loadingTask.promise
      .then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        loadedPdf.current = document;
        setPdf(document);
      })
      .catch((errorValue) => {
        if (!cancelled) callbacks.current.onError(`Could not open this PDF: ${formatError(errorValue)}`);
      });
    return () => {
      cancelled = true;
      void loadingTask.destroy();
      if (loadedPdf.current) {
        void loadedPdf.current.destroy();
        loadedPdf.current = undefined;
      }
    };
  }, [book.format, data]);

  useEffect(() => {
    if (!pdf || !container.current) return;
    let cancelled = false;
    visibleTextRef.current = "";
    void pdf
      .getPage(page)
      .then((item) => {
        if (cancelled || !container.current) return;
        container.current.replaceChildren();
        const baseViewport = item.getViewport({ scale: 1 });
        const viewport = item.getViewport({
          scale: Math.min(1.5, (container.current.clientWidth - 40) / baseViewport.width),
        });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        container.current.append(canvas);
        void item
          .getTextContent()
          .then((content) => {
            if (!cancelled)
              visibleTextRef.current = content.items
                .map((entry) => ("str" in entry ? entry.str : ""))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
          })
          .catch(() => {
            if (!cancelled) visibleTextRef.current = "";
          });
        return item.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      })
      .catch((errorValue) => {
        if (!cancelled && mounted.current)
          callbacks.current.onError(`Could not render this PDF page: ${formatError(errorValue)}`);
      });
    callbacks.current.scheduleProgress({ position: String(page), percentage: page / pdf.numPages });
    return () => {
      cancelled = true;
    };
  }, [pdf, page, container]);

  return { page, setPage, numPages: pdf?.numPages, visibleText: () => visibleTextRef.current };
}
