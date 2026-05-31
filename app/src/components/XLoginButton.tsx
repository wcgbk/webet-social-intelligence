"use client";

import { useState, useEffect, useCallback, createContext, useContext } from "react";

interface XUser {
  name: string;
  username: string;
  image?: string;
}

interface XAuthContextValue {
  user: XUser | null;
  isLoggedIn: boolean;
  login: () => void;
  logout: () => void;
}

const XAuthContext = createContext<XAuthContextValue>({
  user: null,
  isLoggedIn: false,
  login: () => {},
  logout: () => {},
});

export function useXAuth() {
  return useContext(XAuthContext);
}

export function XAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<XUser | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("x_user");
    if (stored) {
      try {
        setUser(JSON.parse(stored));
      } catch {
        localStorage.removeItem("x_user");
      }
    }
  }, []);

  const login = useCallback(() => {
    // In production, this triggers X OAuth 2.0 PKCE flow
    // For static deployment, prompt for X username to demonstrate the UI
    const username = prompt("Enter your X username (without @):");
    if (!username) return;
    const newUser: XUser = {
      name: username,
      username: username,
      image: `https://unavatar.io/x/${username}`,
    };
    setUser(newUser);
    localStorage.setItem("x_user", JSON.stringify(newUser));
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    localStorage.removeItem("x_user");
  }, []);

  return (
    <XAuthContext.Provider value={{ user, isLoggedIn: !!user, login, logout }}>
      {children}
    </XAuthContext.Provider>
  );
}

export function XLoginButton() {
  const { user, isLoggedIn, login, logout } = useXAuth();

  if (isLoggedIn && user) {
    return (
      <div className="flex items-center gap-3">
        {user.image && (
          <img
            src={user.image}
            alt=""
            className="h-9 w-9 rounded-full"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <span className="text-sm text-[var(--foreground)]">@{user.username}</span>
        <button
          onClick={logout}
          className="rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={login}
      className="flex items-center gap-2 rounded-full bg-white px-6 py-3 font-bold text-black transition-opacity hover:opacity-90"
    >
      <XLogo />
      Sign in with X
    </button>
  );
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
