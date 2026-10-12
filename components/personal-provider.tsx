"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PersonalSummary } from "@/lib/personal/store";

type PersonalState =
  | { status: "unavailable" | "loading" | "guest" | "error"; summary: null }
  | { status: "ready"; summary: PersonalSummary };
type PersonalContextValue = PersonalState & { refresh: () => Promise<void> };
const PersonalContext = createContext<PersonalContextValue | null>(null);

async function loadPersonal(signal?: AbortSignal): Promise<PersonalState> {
  try {
    const response = await fetch("/api/personal/summary", { cache: "no-store", credentials: "same-origin", signal });
    if (response.status === 401) return { status: "guest", summary: null };
    if (!response.ok) throw new Error("Unavailable");
    const payload = await response.json();
    if (payload?.success !== true || !Array.isArray(payload.data?.movies) || !payload.data?.profile) {
      throw new Error("Invalid personal response");
    }
    return { status: "ready", summary: payload.data as PersonalSummary };
  } catch { return { status: "error", summary: null }; }
}

export function PersonalProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [state, setState] = useState<PersonalState>(enabled ? { status: "loading", summary: null } :
    { status: "unavailable", summary: null });
  const refresh = useCallback(async () => {
    if (!enabled) { setState({ status: "unavailable", summary: null }); return; }
    setState(await loadPersonal());
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadPersonal(controller.signal).then((next) => { if (!controller.signal.aborted) setState(next); });
    return () => controller.abort();
  }, [enabled]);
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

export function usePersonal() {
  const context = useContext(PersonalContext);
  if (!context) throw new Error("PersonalProvider is missing.");
  return context;
}
