'use client';

import { useEffect, useRef, type RefObject } from 'react';

const selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps keyboard focus in a modal and restores it to the invoking control. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  options: { onEscape?: () => void; initialFocus?: RefObject<HTMLElement | null>; returnFocus?: HTMLElement | null } = {},
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = optionsRef.current.returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const frame = requestAnimationFrame(() => {
      const initial = optionsRef.current.initialFocus?.current || dialog.querySelector<HTMLElement>('[autofocus]') || dialog.querySelector<HTMLElement>(selector);
      initial?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && optionsRef.current.onEscape) {
        event.preventDefault(); optionsRef.current.onEscape(); return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((item) => item.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [dialogRef]);
}
