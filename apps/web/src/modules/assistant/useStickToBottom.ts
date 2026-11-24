import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Distance from the end, in pixels, that still counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 80;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Pure decision used by the scroll hook and its tests. */
export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

type StickToBottomOptions = {
  /** Changes whenever the transcript grows or its Markdown is re-rendered. */
  content: unknown;
  /** Changes only for explicit user actions (send, retry) that must reach the end. */
  signal?: unknown;
};

/**
 * Keeps a transcript scrolled to the end while the reader is already there and
 * never pulls it back after they scrolled up. Only the transcript element is
 * touched, so the page around it cannot scroll.
 */
export function useStickToBottom({ content, signal }: StickToBottomOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  const observerRef = useRef<ResizeObserver | null>(null);
  const signalSeen = useRef(false);

  const remember = useCallback((value: boolean) => {
    nearBottomRef.current = value;
    setNearBottom(value);
  }, []);

  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    remember(true);
  }, [remember]);

  // New content pins to the end only when the reader was already there.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !nearBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [content]);

  // Sending or retrying always returns to the end, even from the middle.
  useLayoutEffect(() => {
    if (!signalSeen.current) {
      signalSeen.current = true;
      return;
    }
    scrollToEnd();
  }, [signal, scrollToEnd]);

  // Code highlighting, images and tables can change height after a delta.
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      if (!element || !nearBottomRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pin = () => {
      if (!nearBottomRef.current) return;
      element.scrollTop = element.scrollHeight;
    };
    window.addEventListener("resize", pin);
    let containerObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      containerObserver = new ResizeObserver(pin);
      containerObserver.observe(element);
    }
    return () => {
      window.removeEventListener("resize", pin);
      containerObserver?.disconnect();
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    remember(isNearBottom(element));
  }, [remember]);

  return {
    scrollRef,
    contentRef,
    onScroll,
    nearBottom,
    showJump: !nearBottom,
    jumpToLatest: scrollToEnd,
  };
}
