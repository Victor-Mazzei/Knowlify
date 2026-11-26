import { isReleaseVersion } from "./updateVersion";

/**
 * Only the official release page on GitHub becomes a link. The server builds
 * this URL, but the web revalidates it as untrusted input before rendering it:
 * one scheme, one host and one path shape, with no query, fragment, port or
 * credentials.
 */
const RELEASE_PATH = /^\/Victor-Mazzei\/Knowlify\/releases\/tag\/([^/]+)$/;
const MAX_URL_LENGTH = 256;

export function releaseUrl(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.hostname !== "github.com") return null;
  // The constructed URL has no explicit port, userinfo, query or fragment.
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  const match = RELEASE_PATH.exec(url.pathname);
  if (!match) return null;
  const tag = match[1];
  if (!tag.startsWith("v") || tag.length > 64) return null;
  if (!isReleaseVersion(tag.slice(1))) return null;

  return url.toString();
}
