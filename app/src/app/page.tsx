"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { XLoginButton } from "@/components/XLoginButton";
import { ConversationWindow, type Message } from "@/components/ConversationWindow";
import { ChatInput } from "@/components/ChatInput";
import { VoiceToggle, speakText } from "@/components/VoiceToggle";
import { SendToClaudeButton } from "@/components/SendToClaudeButton";
import { OnboardingSection } from "@/components/OnboardingSection";

export default function Home() {
  const { data: session } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [grokApiKey, setGrokApiKey] = useState<string>();
  const [grokConfigured, setGrokConfigured] = useState(false);
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);

  const sendMessage = useCallback(
    async (content: string) => {
      const userMessage: Message = { role: "user", content, timestamp: Date.now() };
      const newMessages = [...messages, userMessage];
      setMessages(newMessages);
      setIsStreaming(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
            apiKey: grokApiKey,
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${err.error}`, timestamp: Date.now() },
          ]);
          setIsStreaming(false);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let assistantContent = "";

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "", timestamp: Date.now() },
        ]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  assistantContent += delta;
                  setMessages((prev) => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: "assistant",
                      content: assistantContent,
                      timestamp: Date.now(),
                    };
                    return updated;
                  });
                }
              } catch {
                // Skip non-JSON lines
              }
            }
          }
        }

        // TTS playback if voice is active
        if (isVoiceActive && assistantContent) {
          await speakText(assistantContent);
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Failed to connect to Grok. Check your API key and try again.",
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, grokApiKey, isVoiceActive]
  );

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage]
  );

  const handleKeysSubmit = (grok: string, anthropic: string) => {
    if (grok) {
      setGrokApiKey(grok);
      setGrokConfigured(true);
    }
    if (anthropic) setAnthropicConfigured(true);
  };

  return (
    <main className="min-h-screen">
      {/* ─── Above the Fold ─── */}
      <section className="flex min-h-screen flex-col px-4 py-6">
        {/* Header */}
        <header className="mx-auto flex w-full max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">
              <span className="text-[var(--grok-purple)]">Grok</span>
              <span className="mx-2 text-[var(--muted)]">→</span>
              <span className="text-[var(--claude-orange)]">Claude Code</span>
            </h1>
          </div>
          <XLoginButton />
        </header>

        {/* Main widget area */}
        <div className="mx-auto mt-8 flex w-full max-w-3xl flex-1 flex-col gap-4">
          {/* Controls row */}
          <div className="flex items-center gap-3">
            <VoiceToggle
              isActive={isVoiceActive}
              onToggle={() => setIsVoiceActive((v) => !v)}
              onTranscript={handleVoiceTranscript}
            />
            <div className="flex-1" />
            <SendToClaudeButton messages={messages} disabled={isStreaming} />
          </div>

          {/* Conversation */}
          <ConversationWindow
            messages={messages}
            isStreaming={isStreaming}
            isVoiceActive={isVoiceActive}
          />

          {/* Chat input */}
          <ChatInput onSend={sendMessage} disabled={isStreaming} />
        </div>
      </section>

      {/* ─── Below the Fold ─── */}
      {session && (
        <div className="border-t border-[var(--border)] bg-[var(--background)] px-4 pb-16">
          <OnboardingSection
            onKeysSubmit={handleKeysSubmit}
            grokConfigured={grokConfigured}
            anthropicConfigured={anthropicConfigured}
          />
        </div>
      )}
    </main>
  );
}
