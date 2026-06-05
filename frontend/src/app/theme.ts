import { createTheme } from "@mui/material/styles";
import type { ThemeMode } from "../stores/themeStore";

export function createAppTheme(mode: ThemeMode) {
  const isDark = mode === "dark";

  return createTheme({
  palette: {
    mode,
    primary: {
      main: isDark ? "#7aa7ff" : "#2457a6"
    },
    secondary: {
      main: isDark ? "#4db6ac" : "#00796b"
    },
    background: {
      default: isDark ? "#101418" : "#f5f7fb",
      paper: isDark ? "#171c22" : "#ffffff"
    },
    divider: isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)",
    text: {
      primary: isDark ? "#eef2f7" : "#111827",
      secondary: isDark ? "#aab4c0" : "#526070"
    }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    button: {
      textTransform: "none",
      fontWeight: 600
    }
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 6
        }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 8
        }
      }
    }
  }
});
}
