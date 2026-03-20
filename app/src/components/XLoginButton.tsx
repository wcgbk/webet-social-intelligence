"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export function XLoginButton() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <button
        disabled
        className="flex items-center gap-2 rounded-full bg-white px-6 py-3 font-bold text-black opacity-50"
      >
        <XLogo />
        Loading...
      </button>
    );
  }

  if (session) {
    return (
      <div className="flex items-center gap-3">
        {session.user?.image && (
          <img
            src={session.user.image}
            alt=""
            className="h-9 w-9 rounded-full"
          />
        )}
        <span className="text-sm text-[var(--foreground)]">
          @{session.user?.name}
        </span>
        <button
          onClick={() => signOut()}
          className="rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => signIn("twitter")}
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
