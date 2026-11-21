import { createContext, useContext, useLayoutEffect } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ChatExcerpt } from "./excerpt";
import type { TutorReaderContext, TutorSlot, TutorSurface, TutorView } from "./tutorTypes";
import type { ChatStatus, ConversationSummary } from "./types";

export type TutorContextValue = {
  api: ApiFn;
  status: ChatStatus | null;
  enabled: boolean;
  loading: boolean;
  open: boolean;
  surface: TutorSurface;
  view: TutorView;
  reader: TutorReaderContext | null;
  slots: TutorSlot[];
  activeKey: string;
  activeSlot: TutorSlot | undefined;
  /** Bumped whenever a conversation is created or deleted, to refresh lists. */
  revision: number;
  openTutor: () => void;
  closeTutor: () => void;
  toggleTutor: () => void;
  setView: (view: TutorView) => void;
  setMode: (mode: "library" | "book") => void;
  askAbout: (excerpt: ChatExcerpt) => void;
  useVisibleText: (key: string) => void;
  clearExcerpt: (key: string) => void;
  selectConversation: (conversation: ConversationSummary) => void;
  rememberConversation: (key: string, summary: ConversationSummary) => void;
  setSlotStreaming: (key: string, streaming: boolean) => void;
  resetSlot: (key: string) => void;
  forgetConversation: (id: string) => void;
  isConversationStreaming: (id: string) => boolean;
  registerReaderContext: (context: TutorReaderContext) => () => void;
};

export const TutorContext = createContext<TutorContextValue | null>(null);

export function useTutor(): TutorContextValue {
  const value = useContext(TutorContext);
  if (!value) throw new Error("useTutor must be used inside the tutor provider.");
  return value;
}

/** For the reader, which can render standalone in tests and fixtures. */
export function useTutorOptional(): TutorContextValue | null {
  return useContext(TutorContext);
}

/** Registers the reader's current page for the tutor; the context is cleared on unmount. */
export function useRegisterTutorContext(context: TutorReaderContext | null) {
  const tutor = useTutorOptional();
  const register = tutor?.registerReaderContext;
  useLayoutEffect(() => {
    if (!register || !context) return;
    return register(context);
  }, [register, context]);
}
