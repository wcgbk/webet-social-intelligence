import type { Metadata } from "next";
import { XAuthProvider } from "@/components/XLoginButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grok → Claude Code",
  description: "Chat with Grok, send structured prompts to Claude Code",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <XAuthProvider>{children}</XAuthProvider>
      </body>
    </html>
  );
}
