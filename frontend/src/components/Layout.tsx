import LogoutIcon from "@mui/icons-material/Logout";
import DashboardIcon from "@mui/icons-material/Dashboard";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import AppBar from "@mui/material/AppBar";
import IconButton from "@mui/material/IconButton";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useThemeStore } from "../stores/themeStore";

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const mode = useThemeStore((state) => state.mode);
  const toggleMode = useThemeStore((state) => state.toggleMode);

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="sticky" color="inherit" elevation={1}>
        <Toolbar sx={{ gap: 1.25, px: { xs: 2, lg: 3 }, flexWrap: "wrap" }}>
          <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
            Local Workflow Runner
          </Typography>
          <Button component={RouterLink} to="/dashboard" startIcon={<DashboardIcon />} variant="text">
            Dashboard
          </Button>
          <Tooltip title={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            <IconButton onClick={toggleMode} color="inherit">
              {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
          {user && <Chip size="small" label={user.username} />}
          <Button
            startIcon={<LogoutIcon />}
            variant="outlined"
            onClick={() => {
              clearAuth();
              navigate("/login");
            }}
          >
            Logout
          </Button>
        </Toolbar>
      </AppBar>
      <Box component="main" sx={{ width: "100%", px: { xs: 1.5, md: 2.5, xl: 4 }, py: 2.5 }}>
        {children}
      </Box>
    </Box>
  );
}
