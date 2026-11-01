"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@/lib/types";
import { searchNotes, type SearchOptions } from "./search";
import { SearchWorkerClient, type SearchWorkerPort } from "./search-worker-client";

interface SearchState { ids: string[]; key: string; workspaceId: string | null; searching: boolean; error: string | null; }

/**
 * Off-main-thread search scoped to the current workspace. Note deltas go to the
 * worker only when the index changes; query keystrokes send only query/options.
 */
export function useLocalSearch(notes: Note[], query: string, options: SearchOptions, workspaceId: string | null) {
  const key = JSON.stringify([query, options.tags || [], options.from || "", options.to || ""]);
  const current = useRef({ notes, query, options, key, workspaceId });
  current.current = { notes, query, options, key, workspaceId };
  const indexedNotes = useRef<Note[] | null>(null);
  const client = useRef<SearchWorkerClient | null>(null);
  const [fallback, setFallback] = useState(false);
  const [state, setState] = useState<SearchState>({ ids: [], key: "", workspaceId, searching: true, error: null });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    setFallback(false);
    setState({ ids: [], key: "", workspaceId, searching: true, error: null });
    indexedNotes.current = null;
    try {
      const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
      const instance = new SearchWorkerClient(worker as SearchWorkerPort, (ids, resultKey) => {
        if (active && workspaceId === current.current.workspaceId && resultKey === current.current.key && indexedNotes.current === current.current.notes) {
          setState({ ids, key: resultKey, workspaceId, searching: false, error: null });
        }
      }, () => {
        if (active) { client.current = null; setFallback(true); }
      });
      client.current = instance;
      instance.updateNotes(current.current.notes);
      indexedNotes.current = current.current.notes;
    } catch {
      client.current = null;
      setFallback(true);
    }
    return () => {
      active = false;
      client.current?.dispose();
      client.current = null;
      indexedNotes.current = null;
    };
  }, [workspaceId]);

  useEffect(() => {
    const instance = client.current;
    if (!instance || indexedNotes.current === notes) return;
    const changed = instance.updateNotes(notes);
    indexedNotes.current = notes;
    if (changed) setState((previous) => ({ ...previous, searching: true, error: null }));
    else if (stateRef.current.searching) {
      const latest = current.current;
      instance.search(latest.query, latest.options, latest.key);
    } else {
      // The array identity changed but indexed content did not; reveal the
      // already-valid results after updating indexedNotes.current.
      setState((previous) => ({ ...previous }));
    }
  }, [notes, workspaceId]);

  useEffect(() => {
    setState((previous) => ({ ...previous, searching: true, error: null }));
    // Debounce typing; SearchWorkerClient also coalesces requests while busy.
    const timer = window.setTimeout(() => {
      const latest = current.current;
      if (client.current && !fallback) client.current.search(latest.query, latest.options, latest.key);
      else {
        // A worker can be unavailable in older/restricted browsers; retain a
        // functional (but synchronous) fallback rather than inventing results.
        try {
          const ids = searchNotes(latest.notes, latest.query, latest.options).map((note) => note.id);
          if (latest.key === current.current.key && latest.notes === current.current.notes && latest.workspaceId === current.current.workspaceId) setState({ ids, key: latest.key, workspaceId: latest.workspaceId, searching: false, error: null });
        } catch {
          if (latest.key === current.current.key && latest.workspaceId === current.current.workspaceId) setState({ ids: [], key: latest.key, workspaceId: latest.workspaceId, searching: false, error: "Search couldn’t finish. Try another query or reopen search." });
        }
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [key, workspaceId, fallback]);

  useEffect(() => {
    if (!fallback) return;
    setState((previous) => ({ ...previous, searching: true, error: null }));
    const timer = window.setTimeout(() => {
      const latest = current.current;
      try {
        const ids = searchNotes(latest.notes, latest.query, latest.options).map((note) => note.id);
        if (latest.key === current.current.key && latest.notes === current.current.notes && latest.workspaceId === current.current.workspaceId) setState({ ids, key: latest.key, workspaceId: latest.workspaceId, searching: false, error: null });
      } catch {
        if (latest.key === current.current.key && latest.workspaceId === current.current.workspaceId) setState({ ids: [], key: latest.key, workspaceId: latest.workspaceId, searching: false, error: "Search couldn’t finish. Try another query or reopen search." });
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [notes, workspaceId, fallback]);

  const byId = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const currentResult = state.key === key && state.workspaceId === workspaceId;
  const results = useMemo(() => currentResult ? state.ids.flatMap((id) => { const note = byId.get(id); return note ? [note] : []; }) : [], [state.ids, currentResult, byId]);
  return { results, searching: state.searching || !currentResult || (!fallback && indexedNotes.current !== notes), error: currentResult ? state.error : null, fallback };
}
