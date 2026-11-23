import { createContext, useContext, useLayoutEffect } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { ChatExcerpt } from "./excerpt";
import type { TutorReaderContext, TutorSlot, TutorSurface, TutorView } from "./tutorTypes";
import type { ChatMessage, ChatMode, ChatStatus, ConversationSummary, RecommendPreference } from "./types";
import type { ChatLimitDetails } from "./useChat";

export type TutorContextValue = {
  api: ApiFn;
  status: ChatStatus | null;
  enabled: boolean;
  loading: boolean;
  /** The server advertises Ask; without it every surface stays Session only. */
  modesSupported: boolean;
  open: boolean;
  surface: TutorSurface;
  view: TutorView;
  reader: TutorReaderContext | null;
  slots: TutorSlot[];
  activeKey: string;
  activeSlot: TutorSlot | undefined;
  /** Bumped whenever a conversation is created, renamed or deleted, to refresh lists. */
  revision: number;
  /** Effective session limit, including a 409 reported by the server. */
  sessionLimit: { limit: number; count: number } | null;
  openTutor: () => void;
  closeTutor: () => void;
  toggleTutor: () => void;
  setView: (view: TutorView) => void;
  /** Switches scope; warns first when an Ask chat would be discarded. */
  setMode: (mode: "library" | "book") => void;
  /** Switches Ask/Session; warns first when an Ask chat would be discarded. */
  setChatMode: (mode: ChatMode) => void;
  setSlotMode: (key: string, mode: ChatMode) => void;
  setSlotUseLibrary: (key: string, useLibrary: boolean) => void;
  setSlotRecommend: (key: string, recommend: RecommendPreference) => void;
  /** "New session" never deletes the previous one. */
  startNewSession: () => void;
  reportSessionLimit: (details: ChatLimitDetails) => void;
  clearSessionLimit: () => void;
  refreshStatus: () => void;
  /** ChatPanel registers a getter so the save dialog can read the Ask transcript. */
  registerTranscript: (key: string, get: () => ChatMessage[]) => () => void;
  askAbout: (excerpt: ChatExcerpt) => void;
  useVisibleText: (key: string) => void;
  clearExcerpt: (key: string) => void;
  selectConversation: (conversation: ConversationSummary) => void;
  rememberConversation: (key: string, summary: ConversationSummary) => void;
  resumeSession: (key: string, summary: ConversationSummary) => void;
  markResumeChecked: (key: string) => void;
  renameConversation: (id: string, title: string) => void;
  setSlotStreaming: (key: string, streaming: boolean) => void;
  resetSlot: (key: string) => void;
  forgetConversation: (id: string) => void;
  isConversationStreaming: (id: string) => boolean;
  registerReaderContext: (context: TutorReaderContext) => () => void;
  /** Closes the tutor before a suggestion link opens on a narrow (modal) dock. */
  dismissOnNarrowNavigation: () => void;
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
