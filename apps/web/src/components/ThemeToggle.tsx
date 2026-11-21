import { useEffect, useState } from "react";
import { getTheme, nextTheme, setTheme, subscribeTheme, type Theme } from "../services/theme";

export const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

export function useTheme() {
  const [theme, set] = useState<Theme>(getTheme);
  useEffect(() => subscribeTheme(set), []);
  return theme;
}

export function ThemeToggle() {
  const theme = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[nextTheme(theme)]}`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      onClick={() => {
        setTheme(nextTheme(theme));
      }}
    >
      <span aria-hidden="true">{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</span>
      {THEME_LABEL[theme]}
    </button>
  );
}
