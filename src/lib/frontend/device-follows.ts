"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "insiderindex:device-follows:v2";
const LEGACY_STORAGE_KEY = "stocklana:device-follows:v2";
const EVENT_NAME = "insiderindex:follows-changed";

function readStored(): string[] {
  if (typeof window === "undefined") return [];
  const found = new Set<string>();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === "string") found.add(id);
    // Keep compatibility with the earlier per-person follow key used by the person prototype.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const prefixes = ["insiderindex:person-follow:", "stocklana:person-follow:"];
      for (const prefix of prefixes) if (key?.startsWith(prefix) && localStorage.getItem(key) === "true") found.add(key.slice(prefix.length));
    }
  } catch {}
  return [...found];
}

function writeStored(ids: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch {}
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function useDeviceFollows() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setIds(readStored());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(EVENT_NAME, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVENT_NAME, sync);
    };
  }, []);
  const toggle = useCallback((id: string) => {
    const current = readStored();
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    writeStored(next);
    setIds(next);
  }, []);
  return { ids, following: (id: string) => ids.includes(id), toggle };
}
