import { useEffect, useRef, useState } from "react";
import ePub, { EpubCFI } from "epubjs";
import type { Book as EpubBook, Rendition } from "epubjs";
import type { MutableRefObject, RefObject } from "react";
import { formatError } from "../../services/api";
import type { Book, Progress } from "../../types";
import type { Note, Selection } from "../notes/types";
import { readFontSize } from "../settings/preferences";
import { isRangeCfi, PAGE_CHARS, resolvable } from "./cfi";

type EpubLocation = {
  start: { cfi?: string; percentage?: number; href?: string };
  end?: { cfi?: string };
};

export function useEpubReader({
  book,
  data,
  container,
  initialPosition,
  notes,
  scheduleProgress,
  flushProgress,
  latestProgress,
  onError,
  onSelection,
}: {
  book: Book;
  data: ArrayBuffer;
  container: RefObject<HTMLDivElement | null>;
  initialPosition: string;
  notes: Note[];
  scheduleProgress: (progress: Progress) => void;
  flushProgress: () => void;
  latestProgress: MutableRefObject<Progress>;
  onError: (message: string) => void;
  onSelection: (selection: Selection | undefined) => void;
}) {
  const epubRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const highlighted = useRef(new Set<string>());
  const mounted = useRef(true);
  const [epubReady, setEpubReady] = useState(false);
  const [epubPage, setEpubPage] = useState({ page: 1, total: 0 });
  const handlers = useRef({ scheduleProgress, flushProgress });
  handlers.current = { scheduleProgress, flushProgress };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (book.format !== "epub" || !container.current) return;
    let cancelled = false;
    const epub = ePub();
    // StrictMode unmounts right after mounting; the destroyed instance's open() then rejects
    // ("No RootFile Found"). The live instance reports its own failures through show() below.
    epub.open(data).catch(() => undefined);
    const rendition = epub.renderTo(container.current, {
      width: "100%",
      height: "100%",
      flow: "paginated",
      spread: "none",
    });
    epubRef.current = epub;
    renditionRef.current = rendition;
    const savedFont = readFontSize();
    if (savedFont !== 100) rendition.themes.fontSize(`${savedFont}%`);
    // Pages render in a script-less sandboxed iframe; drop the book's own <script> tags so the
    // browser does not log a "blocked script execution" error for every page.
    epub.spine.hooks.serialize.register((output: string, section: { output: string }) => {
      section.output = output.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
    });
    const updatePage = (cfi?: string) => {
      if (!cfi || !epub.locations?.length()) return;
      const total = epub.locations.length();
      const index = Number(epub.locations.locationFromCfi(cfi));
      if (Number.isFinite(index)) setEpubPage({ page: Math.min(total, index + 1), total });
    };
    // A saved position the book can no longer resolve leaves epub.js on a blank
    // page, so fall back to the start of the book.
    const show = async () => {
      const startAt = initialPosition;
      await epub.ready;
      if (!startAt || !resolvable(epub, startAt)) return rendition.display();
      // True when the requested position is inside what is currently on screen.
      const onScreen = () => {
        try {
          const location = rendition.currentLocation() as unknown as EpubLocation;
          const cfi = new EpubCFI();
          return cfi.compare(startAt, location.start.cfi ?? "") >= 0 && cfi.compare(startAt, location.end?.cfi ?? "") <= 0;
        } catch {
          return false;
        }
      };
      try {
        await rendition.display(startAt);
        // The chapter keeps reflowing while images and fonts load, so the first offset can be
        // stale and leave the reader at the top of the chapter. Re-aim until it sticks.
        for (let attempt = 0; attempt < 4 && !cancelled && !onScreen(); attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          if (cancelled) break;
          await rendition.display(startAt);
        }
        if ((rendition.currentLocation() as unknown as EpubLocation)?.start?.cfi) return;
      } catch {
        /* fall through to the start */
      }
      return rendition.display();
    };
    void show()
      .then(async () => {
        if (!mounted.current || cancelled) return;
        setEpubReady(true);
        const cacheKey = `knowlify.locations.${book.id}.${PAGE_CHARS}`;
        try {
          for (const key of Object.keys(localStorage))
            if (key.startsWith(`knowlify.locations.${book.id}`) && key !== cacheKey) localStorage.removeItem(key);
          const cached = localStorage.getItem(cacheKey);
          if (cached) epub.locations.load(cached);
        } catch {
          /* regenerate below */
        }
        if (!epub.locations.length()) {
          await epub.locations.generate(PAGE_CHARS);
          try {
            localStorage.setItem(cacheKey, epub.locations.save());
          } catch {
            /* too large or unavailable */
          }
        }
        if (cancelled || !mounted.current) return;
        const cfi = (rendition.currentLocation() as unknown as EpubLocation)?.start?.cfi;
        updatePage(cfi);
        const percentage = cfi ? Number(epub.locations.percentageFromCfi(cfi)) : NaN;
        if (cfi && Number.isFinite(percentage)) handlers.current.scheduleProgress({ position: cfi, percentage });
      })
      .catch((errorValue) => {
        if (mounted.current) onError(`Could not open this EPUB: ${formatError(errorValue)}`);
      });
    rendition.on("relocated", (location: EpubLocation) => {
      const cfi = location?.start?.cfi;
      if (!cfi) return;
      updatePage(cfi);
      const located = epub.locations?.length() ? Number(epub.locations.percentageFromCfi(cfi)) : Number(location.start.percentage);
      handlers.current.scheduleProgress({ position: cfi, percentage: Number.isFinite(located) ? located : 0 });
    });
    rendition.on("selected", (cfiRange: string) => {
      const text = String(rendition.getRange(cfiRange)?.toString() ?? "").trim();
      if (text) onSelection({ location: cfiRange, text });
    });
    return () => {
      cancelled = true;
      // The rendition has no manager until the first display finishes (React
      // StrictMode unmounts immediately), so reading its location can throw.
      try {
        const location = (rendition.currentLocation() as unknown as EpubLocation)?.start;
        if (location?.cfi) {
          const percentage = epub.locations?.length() ? Number(epub.locations.percentageFromCfi(location.cfi)) : Number(location.percentage);
          latestProgress.current = { position: location.cfi, percentage: Number.isFinite(percentage) ? percentage : 0 };
        }
      } catch {
        /* nothing displayed yet */
      }
      handlers.current.flushProgress();
      highlighted.current.clear();
      renditionRef.current = null;
      epubRef.current = null;
      try {
        epub.destroy();
      } catch {
        /* already torn down */
      }
    };
  }, [book.format, book.id, data]);

  // Highlights for notes that were attached to a text selection.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!epubReady || !rendition) return;
    const wanted = new Set(notes.map((note) => note.location).filter(isRangeCfi));
    for (const cfi of [...highlighted.current]) {
      if (wanted.has(cfi)) continue;
      try {
        rendition.annotations.remove(cfi, "highlight");
      } catch {
        /* view already gone */
      }
      highlighted.current.delete(cfi);
    }
    for (const cfi of wanted) {
      if (highlighted.current.has(cfi)) continue;
      try {
        rendition.annotations.highlight(cfi, {}, undefined, "note-highlight", {
          fill: "#e0b43c",
          "fill-opacity": "0.35",
          "mix-blend-mode": "multiply",
        });
        highlighted.current.add(cfi);
      } catch {
        /* range not resolvable in this book */
      }
    }
  }, [notes, epubReady]);

  const goToPage = (page: number) => {
    const epub = epubRef.current;
    if (!epub?.locations?.length()) return;
    const cfi = epub.locations.cfiFromLocation(Math.min(Math.max(page, 1), epubPage.total) - 1);
    if (cfi) void renditionRef.current?.display(cfi);
  };

  const step = (delta: 1 | -1) => {
    void (delta > 0 ? renditionRef.current?.next() : renditionRef.current?.prev());
  };

  const currentCfi = () => {
    const location = renditionRef.current?.currentLocation() as unknown as EpubLocation | undefined;
    return location?.start?.cfi ?? "";
  };

  const displayLocation = (location: string) => {
    if (epubRef.current && resolvable(epubRef.current, location)) {
      void renditionRef.current?.display(location);
      return true;
    }
    return false;
  };

  /** Text currently on screen, used as optional context for the chat. */
  const visibleText = () => {
    try {
      const rendition = renditionRef.current;
      if (!rendition) return "";
      const contents = rendition.getContents() as unknown as Array<{
        document?: Document;
        range?: (cfi?: string) => Range | null;
      }>;
      const location = rendition.currentLocation() as unknown as EpubLocation | undefined;
      const startCfi = location?.start?.cfi;
      const endCfi = location?.end?.cfi;
      if (startCfi && endCfi) {
        for (const content of contents ?? []) {
          try {
            const start = content.range?.(startCfi);
            const end = content.range?.(endCfi);
            if (!start || !end) continue;
            const range = start.cloneRange();
            range.setEnd(end.endContainer, end.endOffset);
            const text = range.toString().replace(/\s+/g, " ").trim();
            if (text) return text;
          } catch {
            /* range crosses documents or is not resolvable */
          }
        }
      }
      return (contents ?? [])
        .map((item) => item.document?.body?.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      return "";
    }
  };

  /** Chapter file name (without extension) for citation context; empty when unknown. */
  const currentSection = () => {
    try {
      const href = (renditionRef.current?.currentLocation() as unknown as EpubLocation | undefined)?.start?.href ?? "";
      const file = href.split("#")[0]?.split("/").pop() ?? "";
      return decodeURIComponent(file).replace(/\.x?html?$/i, "");
    } catch {
      return "";
    }
  };

  return { epubReady, epubPage, goToPage, step, currentCfi, displayLocation, visibleText, currentSection };
}
