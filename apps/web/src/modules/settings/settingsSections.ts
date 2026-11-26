import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { Credentials } from "../../types";

export type SettingsSectionId =
  | "account"
  | "about"
  | "network"
  | "folders"
  | "tags"
  | "duplicates"
  | "ignored-books"
  | "search-index"
  | "metadata"
  | "ai"
  | "mcp";

export type SettingsGroupId = "general" | "network" | "library" | "metadata" | "ai";

export type SettingsSectionProps = {
  api: ApiFn;
  credentials: Credentials;
  onLogout: () => void;
  onCredentialsChange: (credentials: Credentials) => void;
};

type SettingsSectionMeta = {
  id: SettingsSectionId;
  label: string;
  group: SettingsGroupId;
  description: string;
};

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "folders";

export const SETTINGS_GROUPS: ReadonlyArray<{
  id: SettingsGroupId;
  label: string;
  sections: readonly SettingsSectionId[];
}> = [
  { id: "general", label: "General", sections: ["account", "about"] },
  { id: "network", label: "Network", sections: ["network"] },
  { id: "library", label: "Library", sections: ["folders", "tags", "duplicates", "ignored-books", "search-index"] },
  { id: "metadata", label: "Metadata", sections: ["metadata"] },
  { id: "ai", label: "AI", sections: ["ai", "mcp"] },
];

export const SETTINGS_SECTIONS: Record<SettingsSectionId, SettingsSectionMeta> = {
  account: {
    id: "account",
    label: "Account",
    group: "general",
    description: "Your sign-in, this device's appearance and reading preferences, and the KOReader connection.",
  },
  about: {
    id: "about",
    label: "About",
    group: "general",
    description: "The version and runtime details of this Knowlify instance.",
  },
  network: {
    id: "network",
    label: "Network",
    group: "network",
    description: "Share your library with phones and tablets on the same local network.",
  },
  folders: {
    id: "folders",
    label: "Folders",
    group: "library",
    description: "The folders Knowlify reads books from. They are never changed.",
  },
  tags: {
    id: "tags",
    label: "Tags",
    group: "library",
    description: "Rename, recolor and remove tags. Deleting a tag never deletes books.",
  },
  duplicates: {
    id: "duplicates",
    label: "Duplicates",
    group: "library",
    description: "Copies of the same file, reviewed before anything is merged.",
  },
  "ignored-books": {
    id: "ignored-books",
    label: "Ignored books",
    group: "library",
    description: "Books that will not be imported again until you restore them.",
  },
  "search-index": {
    id: "search-index",
    label: "Search index",
    group: "library",
    description: "Background indexing for search and for the assistant's passages.",
  },
  metadata: {
    id: "metadata",
    label: "Metadata lookup",
    group: "metadata",
    description: "Where book details and covers come from.",
  },
  ai: {
    id: "ai",
    label: "AI assistant",
    group: "ai",
    description: "The language model behind Ask and the tutor's instructions.",
  },
  mcp: {
    id: "mcp",
    label: "MCP access",
    group: "ai",
    description: "Tokens that let MCP clients read and write in your library.",
  },
};

/** Old anchors that other modules and bookmarks still use. */
export const LEGACY_SETTINGS_HASHES: Readonly<Record<string, SettingsSectionId>> = {
  account: "account",
  "set-account": "account",
  appearance: "account",
  "set-appearance": "account",
  library: "account",
  "set-library": "account",
  reading: "account",
  "set-reading": "account",
  devices: "account",
  "set-devices": "account",
  about: "about",
  "set-about": "about",
  network: "network",
  share: "network",
  "set-network": "network",
  folders: "folders",
  "set-folders": "folders",
  tags: "tags",
  "set-tags": "tags",
  duplicates: "duplicates",
  "set-duplicates": "duplicates",
  ignored: "ignored-books",
  "ignored-books": "ignored-books",
  "set-ignored": "ignored-books",
  "search-index": "search-index",
  "set-search-index": "search-index",
  metadata: "metadata",
  "set-metadata": "metadata",
  ai: "ai",
  llm: "ai",
  "set-llm": "ai",
  assistant: "ai",
  mcp: "mcp",
  "set-mcp": "mcp",
};

const isOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

export function isSettingsSection(value: string | undefined): value is SettingsSectionId {
  return value !== undefined && isOwn(SETTINGS_SECTIONS, value);
}

export function sectionFromHash(hash: string): SettingsSectionId | null {
  const key = hash.replace(/^#/, "");
  return isOwn(LEGACY_SETTINGS_HASHES, key) ? LEGACY_SETTINGS_HASHES[key] : null;
}

type SectionComponent = LazyExoticComponent<ComponentType<SettingsSectionProps>>;

/**
 * One lazy component per section keeps hidden cards unmounted: their API calls
 * and polling only start when the section is opened.
 */
export const SETTINGS_SECTION_COMPONENTS: Record<SettingsSectionId, SectionComponent> = {
  account: lazy(() => import("./sections/AccountSection")),
  about: lazy(() => import("./sections/AboutSection")),
  network: lazy(() => import("./sections/NetworkSection")),
  folders: lazy(() => import("./sections/FoldersSection")),
  tags: lazy(() => import("./sections/TagsSection")),
  duplicates: lazy(() => import("./sections/DuplicatesSection")),
  "ignored-books": lazy(() => import("./sections/IgnoredBooksSection")),
  "search-index": lazy(() => import("./sections/SearchIndexSection")),
  metadata: lazy(() => import("./sections/MetadataSection")),
  ai: lazy(() => import("./sections/AiSection")),
  mcp: lazy(() => import("./sections/McpSection")),
};
