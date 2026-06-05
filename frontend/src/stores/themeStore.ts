import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const storageKey = "workflow-theme-mode";

function readStoredTheme(): ThemeMode {
  const value = localStorage.getItem(storageKey);
  return value === "dark" ? "dark" : "light";
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredTheme(),
  setMode: (mode) => {
    localStorage.setItem(storageKey, mode);
    set({ mode });
  },
  toggleMode: () => {
    const nextMode = get().mode === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, nextMode);
    set({ mode: nextMode });
  }
}));
