"use client";

import { useState } from "react";
import { AvatarUpload } from "./AvatarUpload";

interface OnboardingSectionProps {
  onKeysSubmit: (grokKey: string, anthropicKey: string) => void;
  grokConfigured: boolean;
  anthropicConfigured: boolean;
}

export function OnboardingSection({
  onKeysSubmit,
  grokConfigured,
  anthropicConfigured,
}: OnboardingSectionProps) {
  const [grokKey, setGrokKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [avatar, setAvatar] = useState<string>();
  const [saving, setSaving] = useState(false);

  const handleSaveKeys = async () => {
    setSaving(true);
    try {
      await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grokApiKey: grokKey || undefined,
          anthropicApiKey: anthropicKey || undefined,
        }),
      });
      onKeysSubmit(grokKey, anthropicKey);
    } finally {
      setSaving(false);
    }
  };

  const steps = [
    {
      id: "profile",
      title: "Set up your profile",
      done: !!avatar,
      content: (
        <AvatarUpload currentAvatar={avatar} onUpload={setAvatar} />
      ),
    },
    {
      id: "grok",
      title: "Configure Grok API key",
      done: grokConfigured || !!grokKey,
      content: (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Get your API key from{" "}
            <a
              href="https://console.x.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] underline"
            >
              console.x.ai
            </a>
          </p>
          <input
            type="password"
            value={grokKey}
            onChange={(e) => setGrokKey(e.target.value)}
            placeholder="xai-..."
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--foreground)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      ),
    },
    {
      id: "anthropic",
      title: "Configure Claude API key",
      done: anthropicConfigured || !!anthropicKey,
      content: (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Get your API key from{" "}
            <a
              href="https://console.anthropic.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] underline"
            >
              console.anthropic.com
            </a>
          </p>
          <input
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder="sk-ant-..."
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--foreground)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      ),
    },
    {
      id: "flow",
      title: "How it works",
      done: true,
      content: (
        <div className="space-y-4 text-sm text-[var(--muted)]">
          <div className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--grok-purple)]/20 text-xs font-bold text-[var(--grok-purple)]">
              1
            </span>
            <p>Chat with Grok using text or voice to explore your idea and refine requirements.</p>
          </div>
          <div className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--grok-purple)]/20 text-xs font-bold text-[var(--grok-purple)]">
              2
            </span>
            <p>Grok streams real-time responses in the conversation window above.</p>
          </div>
          <div className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--claude-orange)]/20 text-xs font-bold text-[var(--claude-orange)]">
              3
            </span>
            <p>
              Click <strong className="text-[var(--foreground)]">"Send to Claude Code"</strong> — the
              full conversation is formatted into a structured prompt with context, goals, and
              instructions extracted.
            </p>
          </div>
          <div className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--claude-orange)]/20 text-xs font-bold text-[var(--claude-orange)]">
              4
            </span>
            <p>
              The prompt is copied to your clipboard and opens via{" "}
              <code className="rounded bg-[var(--card-hover)] px-1.5 py-0.5 text-xs">claude://</code>{" "}
              deep link if available.
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <section className="mx-auto max-w-2xl space-y-6 py-12">
      <h2 className="text-2xl font-bold text-[var(--foreground)]">Get Started</h2>
      <p className="text-[var(--muted)]">Complete the setup to start using Grok → Claude Code</p>

      <div className="space-y-4">
        {steps.map((step, i) => (
          <div
            key={step.id}
            className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6"
          >
            <div className="mb-4 flex items-center gap-3">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                  step.done
                    ? "bg-[var(--success)] text-white"
                    : "bg-[var(--card-hover)] text-[var(--muted)]"
                }`}
              >
                {step.done ? (
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <h3 className="text-lg font-semibold text-[var(--foreground)]">{step.title}</h3>
            </div>
            {step.content}
          </div>
        ))}
      </div>

      {(grokKey || anthropicKey) && (
        <button
          onClick={handleSaveKeys}
          disabled={saving}
          className="w-full rounded-full bg-[var(--success)] py-3 font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save API Keys"}
        </button>
      )}
    </section>
  );
}
