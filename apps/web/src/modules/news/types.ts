export type Feed = {
  id: string;
  kind: "topic" | "custom";
  title: string;
  url: string;
  query?: string;
  enabled: boolean;
  createdAt: number;
};

export type Article = {
  id: string;
  feedId: string;
  feedTitle: string;
  source: string;
  title: string;
  link: string;
  summary: string;
  imageUrl?: string;
  publishedAt?: string;
};

export type Bookmark = {
  id: string;
  title: string;
  link: string;
  source: string;
  summary: string;
  publishedAt?: string;
  savedAt: number;
};

export type NewsError = {
  feedId: string;
  message: string;
};
