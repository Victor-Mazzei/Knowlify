export type Theme = "system" | "light" | "dark";

const KEY = "knowlify.theme";
const ORDER: Theme[] = ["system", "light", "dark"];

export function getTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const EVENT = "knowlify:theme";

/** Calls back whenever the theme changes anywhere in the app, so every control stays in sync. */
export function subscribeTheme(callback: (theme: Theme) => void) {
  const handler = () => callback(getTheme());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
  window.dispatchEvent(new Event(EVENT));
}

export const nextTheme = (theme: Theme): Theme => ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
