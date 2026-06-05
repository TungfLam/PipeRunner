import { zodResolver } from "@hookform/resolvers/zod";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useForm } from "react-hook-form";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { z } from "zod";
import { api } from "../api/client";
import { useAuthStore } from "../stores/authStore";

const schema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, dashes, or underscores"),
  password: z.string().min(8)
});

type FormValues = z.infer<typeof schema>;

export function RegisterPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const submit = async (values: FormValues) => {
    try {
      const response = await api.post("/auth/register", values);
      setAuth(response.data.token, response.data.user);
      navigate("/dashboard");
    } catch {
      setError("root", { message: "Registration failed" });
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "background.default", p: 2 }}>
      <Paper sx={{ width: "100%", maxWidth: 420, p: 3 }} elevation={2}>
        <Stack spacing={2} component="form" onSubmit={handleSubmit(submit)}>
          <Stack direction="row" spacing={1} alignItems="center">
            <PersonAddIcon color="primary" />
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Register
            </Typography>
          </Stack>
          <TextField
            label="Username"
            autoComplete="username"
            {...register("username")}
            error={Boolean(errors.username)}
            helperText={errors.username?.message}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            {...register("password")}
            error={Boolean(errors.password)}
            helperText={errors.password?.message}
          />
          {errors.root && (
            <Typography color="error" variant="body2">
              {errors.root.message}
            </Typography>
          )}
          <Button type="submit" variant="contained" disabled={isSubmitting}>
            {isSubmitting ? "Creating..." : "Create account"}
          </Button>
          <Typography variant="body2" color="text.secondary">
            Already registered?{" "}
            <Link component={RouterLink} to="/login">
              Sign in
            </Link>
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}
