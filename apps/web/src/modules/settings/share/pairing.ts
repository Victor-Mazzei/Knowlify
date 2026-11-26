import type { Credentials } from "../../../types";

/**
 * Sign-in links for the desktop's local-network sharing.
 *
 * The QR code carries `#pair=<base64url(user:password)>`. A fragment is never
 * sent to the server, so the password stays out of request logs. The web app
 * consumes the fragment on boot, stores the credentials like a normal sign-in
 * and removes the fragment from the address bar. Nothing here logs the value.
 */

const PAIR_PREFIX = "#pair=";
/** Same bounds as `services/api`; a longer value cannot authenticate. */
const MAX_USER_LENGTH = 200;
const MAX_PASS_LENGTH = 1000;
/** Encoded upper bound (1201 bytes, rounded up to base64), with slack. */
const MAX_ENCODED_LENGTH = 2048;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (value.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `#pair=...` for the given credentials, without padding. */
export function encodePairingFragment(credentials: Credentials): string {
  const text = `${credentials.user}:${credentials.pass}`;
  return `${PAIR_PREFIX}${toBase64Url(new TextEncoder().encode(text))}`;
}

/** Parsed credentials, or `null` when the fragment is missing or malformed. */
export function decodePairingFragment(fragment: string): Credentials | null {
  if (!fragment.startsWith(PAIR_PREFIX)) return null;
  const text = fromBase64Url(fragment.slice(PAIR_PREFIX.length));
  if (text === null) return null;
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) return null;
  const user = text.slice(0, separator);
  const pass = text.slice(separator + 1);
  if (user.length > MAX_USER_LENGTH || pass.length > MAX_PASS_LENGTH) return null;
  return { user, pass };
}

/** Full sign-in URL for a base address such as `http://10.0.0.5:47870`. */
export function pairingUrl(baseUrl: string, credentials: Credentials): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodePairingFragment(credentials)}`;
}

type PairingLocation = { pathname: string; search: string; hash: string };
type ReplaceState = (url: string) => void;

/**
 * Removes `#pair=...`. `history.replaceState` is the first attempt; setting the
 * hash is the fallback. When neither clears it, the caller must not persist the
 * secret and the link is ignored for this load.
 */
function clearPairingFragment(location: PairingLocation, replaceState: ReplaceState): boolean {
  try {
    replaceState(`${location.pathname}${location.search}`);
  } catch {
    // The fragment setter below is the second attempt.
  }
  if (!location.hash) return true;
  try {
    location.hash = "";
  } catch {
    // Leave the fragment in place; the caller keeps the secret out of storage.
  }
  return !location.hash;
}

/**
 * Reads the fragment once, removes it from the address bar and only then
 * persists the credentials. Invalid input is ignored, so the normal sign-in
 * screen stays. If the browser refuses to remove the fragment, nothing is
 * stored and the password is not repeated anywhere else.
 */
export function consumePairingFragment(
  persist: (credentials: Credentials) => void,
  location: PairingLocation = window.location,
  replaceState: ReplaceState = (url) => window.history.replaceState(null, "", url),
): Credentials | null {
  const credentials = decodePairingFragment(location.hash);
  if (!credentials) return null;
  if (!clearPairingFragment(location, replaceState)) return null;
  try {
    persist(credentials);
  } catch {
    // Blocked storage only loses the credentials on the next reload.
  }
  return credentials;
}

/** `xxxx-xxxx-xxxx-xxxx`; the stored password has no separators. */
export function formatSharePassword(password: string): string {
  return password.match(/.{1,4}/g)?.join("-") ?? password;
}
