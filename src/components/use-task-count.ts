'use client';

import { useEffect, useRef, useState } from 'react';
import type { Note } from '@/lib/types';
import { cachedTasks } from './note-derivations';

/** Populate the sidebar count in small chunks so opening a large library stays responsive. */
export function useTaskCount(notes: Note[], workspaceId: string | null): number | null {
  const [result, setResult] = useState<{ workspaceId: string | null; count: number } | null>(null);
  const latest = useRef({ notes, workspaceId }); latest.current = { notes, workspaceId };
  useEffect(() => {
    let cancelled = false;
    let index = 0;
    let total = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      if (cancelled || latest.current.notes !== notes || latest.current.workspaceId !== workspaceId) return;
      const end = Math.min(index + 25, notes.length);
      for (; index < end; index += 1) total += cachedTasks([notes[index]]).filter((task) => !task.done).length;
      if (index < notes.length) timer = setTimeout(step, 0);
      else setResult({ workspaceId, count: total });
    };
    timer = setTimeout(step, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [notes, workspaceId]);
  return result?.workspaceId === workspaceId ? result.count : null;
}
