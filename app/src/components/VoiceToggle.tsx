"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface VoiceToggleProps {
  isActive: boolean;
  onToggle: () => void;
  onTranscript: (text: string) => void;
}

export function VoiceToggle({ isActive, onToggle, onTranscript }: VoiceToggleProps) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          onTranscript(transcript.trim());
          transcript = "";
        }
      }
    };

    recognition.onerror = () => {
      if (isActive) onToggle();
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
  }, [onTranscript, onToggle, isActive]);

  useEffect(() => {
    if (!recognitionRef.current) return;
    if (isActive) {
      try {
        recognitionRef.current.start();
      } catch {
        // Already started
      }
    } else {
      recognitionRef.current.stop();
    }
  }, [isActive]);

  if (!supported) return null;

  return (
    <button
      onClick={onToggle}
      className={`relative flex items-center gap-2 rounded-full px-5 py-3 font-medium transition-all ${
        isActive
          ? "bg-[var(--grok-purple)] text-white shadow-lg shadow-[var(--grok-purple)]/30"
          : "border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--card-hover)]"
      }`}
    >
      {isActive && (
        <span className="voice-pulse absolute inset-0 rounded-full bg-[var(--grok-purple)]" />
      )}
      <svg
        viewBox="0 0 24 24"
        className="relative h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      <span className="relative">
        {isActive ? "Grok Voice On" : "Grok Voice"}
      </span>
    </button>
  );
}

export function speakText(text: string): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => resolve();
    speechSynthesis.speak(utterance);
  });
}
