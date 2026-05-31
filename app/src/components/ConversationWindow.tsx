"use client";

import { useRef, useEffect } from "react";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

interface ConversationWindowProps {
  messages: Message[];
  isStreaming: boolean;
  isVoiceActive: boolean;
}

export function ConversationWindow({
  messages,
  isStreaming,
  isVoiceActive,
}: ConversationWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      className="flex h-[400px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      {messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center text-[var(--muted)]">
          <GrokIcon />
          <p className="mt-3 text-lg font-medium">Start a conversation with Grok</p>
          <p className="mt-1 text-sm">Type a message or use voice input</p>
        </div>
      )}
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
        >
          <div
            className={`max-w-[80%] rounded-2xl px-4 py-3 ${
              msg.role === "user"
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--card-hover)] text-[var(--foreground)]"
            }`}
          >
            {msg.role === "assistant" && (
              <span className="mb-1 block text-xs font-medium text-[var(--grok-purple)]">
                Grok
              </span>
            )}
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
              {msg.content}
            </p>
          </div>
        </div>
      ))}
      {isStreaming && (
        <div className="flex gap-3">
          <div className="rounded-2xl bg-[var(--card-hover)] px-4 py-3">
            <span className="mb-1 block text-xs font-medium text-[var(--grok-purple)]">
              Grok
            </span>
            <div className="flex gap-1">
              <span className="typing-dot h-2 w-2 rounded-full bg-[var(--muted)]" />
              <span className="typing-dot h-2 w-2 rounded-full bg-[var(--muted)]" />
              <span className="typing-dot h-2 w-2 rounded-full bg-[var(--muted)]" />
            </div>
          </div>
        </div>
      )}
      {isVoiceActive && (
        <div className="flex items-center gap-2 rounded-xl bg-[var(--grok-purple)]/10 px-3 py-2 text-sm text-[var(--grok-purple)]">
          <span className="relative flex h-3 w-3">
            <span className="voice-pulse absolute inline-flex h-full w-full rounded-full bg-[var(--grok-purple)]" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--grok-purple)]" />
          </span>
          Listening...
        </div>
      )}
    </div>
  );
}

function GrokIcon() {
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--grok-purple)]/20">
      <svg viewBox="0 0 24 24" className="h-8 w-8 text-[var(--grok-purple)]" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}
