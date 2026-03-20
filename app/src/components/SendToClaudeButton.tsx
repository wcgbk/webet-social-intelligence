"use client";

import { useState } from "react";
import type { Message } from "./ConversationWindow";

interface SendToClaudeButtonProps {
  messages: Message[];
  disabled: boolean;
}

export function SendToClaudeButton({ messages, disabled }: SendToClaudeButtonProps) {
  const [copied, setCopied] = useState(false);

  const formatPrompt = () => {
    if (messages.length === 0) return "";

    const conversationLog = messages
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join("\n\n");

    // Extract the last user message as the primary goal
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastAssistantMsg = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    return `# Claude Code Task

## Context
The following conversation took place with Grok (xAI) to explore and refine the task requirements.

<conversation>
${conversationLog}
</conversation>

## Goal
${lastUserMsg?.content || "Implement the discussed feature."}

## Key Details from Grok
${lastAssistantMsg?.content || "See conversation above for full context."}

## Instructions
- Review the full conversation above for context
- Implement the solution based on the discussed approach
- Follow best practices and ensure code quality
- Ask clarifying questions if any requirements are ambiguous
`;
  };

  const handleSend = async () => {
    const prompt = formatPrompt();
    if (!prompt) return;

    // Try claude:// deep link first
    const deepLink = `claude://code?prompt=${encodeURIComponent(prompt)}`;

    // Copy to clipboard as fallback
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback: select text in a textarea
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }

    // Attempt deep link
    window.open(deepLink, "_blank");
  };

  return (
    <button
      onClick={handleSend}
      disabled={disabled || messages.length === 0}
      className="flex items-center gap-2 rounded-full bg-[var(--claude-orange)] px-6 py-3 font-bold text-white transition-all hover:bg-[var(--claude-orange-hover)] disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      {copied ? "Copied! Opening Claude..." : "Send to Claude Code"}
    </button>
  );
}
