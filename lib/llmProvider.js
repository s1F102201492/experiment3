"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export const LLM_PROVIDERS = [
  { id: "openai", label: "GPT" },
  { id: "gemini", label: "Gemini" },
];

const STORAGE_KEY = "llm-provider";
const CHANGE_EVENT = "llm-provider-change";

function isProvider(value) {
  return LLM_PROVIDERS.some((item) => item.id === value);
}

function subscribe(callback) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function readStored() {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return isProvider(value) ? value : null;
}

// 選択は localStorage に保存し、ホームと /test で共有する。未選択ならサーバーの LLM_PROVIDER を使う
export function useLlmProvider() {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const [serverInfo, setServerInfo] = useState(null);
  const provider = stored ?? serverInfo?.default_provider ?? null;
  const providerRef = useRef(provider);

  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/analyze")
      .then((response) => response.json())
      .then((info) => {
        if (!cancelled) setServerInfo(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setProvider = useCallback((value) => {
    if (!isProvider(value)) return;
    providerRef.current = value;
    window.localStorage.setItem(STORAGE_KEY, value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return {
    provider,
    providerRef,
    setProvider,
    available: serverInfo?.available ?? null,
  };
}
