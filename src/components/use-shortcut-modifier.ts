'use client';

import { useEffect, useState } from 'react';

/** Use the shortcut notation people expect on their current platform. */
export function useShortcutModifier(): '⌘' | 'Ctrl' {
  const [modifier, setModifier] = useState<'⌘' | 'Ctrl'>('Ctrl');
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
    setModifier(/Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl');
  }, []);
  return modifier;
}
