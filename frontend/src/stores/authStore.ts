import { create } from "zustand";
import type { User } from "../types/domain";

interface AuthState {
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
}

const storedToken = localStorage.getItem("workflow-auth-token");
const storedUser = localStorage.getItem("workflow-auth-user");

export const useAuthStore = create<AuthState>((set) => ({
  token: storedToken,
  user: storedUser ? JSON.parse(storedUser) : null,
  setAuth: (token, user) => {
    localStorage.setItem("workflow-auth-token", token);
    localStorage.setItem("workflow-auth-user", JSON.stringify(user));
    set({ token, user });
  },
  clearAuth: () => {
    localStorage.removeItem("workflow-auth-token");
    localStorage.removeItem("workflow-auth-user");
    set({ token: null, user: null });
  }
}));
