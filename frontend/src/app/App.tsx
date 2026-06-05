import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { useMemo } from "react";
import { Layout } from "../components/Layout";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { ProjectDetailPage } from "../pages/ProjectDetailPage";
import { RegisterPage } from "../pages/RegisterPage";
import { RunHistoryPage } from "../pages/RunHistoryPage";
import { RunPage } from "../pages/RunPage";
import { WorkflowEditorPage } from "../pages/WorkflowEditorPage";
import { useAuthStore } from "../stores/authStore";
import { useThemeStore } from "../stores/themeStore";
import { createAppTheme } from "./theme";

const queryClient = new QueryClient();

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <Layout>
        <Outlet />
      </Layout>
    </ProtectedRoute>
  );
}

function HomeRedirect() {
  const token = useAuthStore((state) => state.token);
  return <Navigate to={token ? "/dashboard" : "/login"} replace />;
}

const router = createBrowserRouter([
  { path: "/", element: <HomeRedirect /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    element: <ProtectedLayout />,
    children: [
      { path: "/dashboard", element: <DashboardPage /> },
      { path: "/projects/:projectId", element: <ProjectDetailPage /> },
      { path: "/projects/:projectId/workflows/:workflowId", element: <WorkflowEditorPage /> },
      { path: "/workflows/:workflowId/runs", element: <RunHistoryPage /> },
      { path: "/runs/:runId", element: <RunPage /> }
    ]
  }
]);

export function App() {
  const mode = useThemeStore((state) => state.mode);
  const theme = useMemo(() => createAppTheme(mode), [mode]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
