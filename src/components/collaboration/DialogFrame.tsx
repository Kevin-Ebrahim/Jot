'use client';

import { X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import './collaboration.css';

/** Native modal dialogs provide focus containment, background inertness and focus
 * restoration. Escape and the backdrop are routed through the controlled prop. */
export function DialogFrame({
  open,
  onClose,
  title,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={`collab-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {open && (
        <motion.div
          className="collab-dialog-inner"
          initial={reduceMotion ? false : { opacity: 0, y: 7, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="collab-dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="collab-icon-button" onClick={onClose} aria-label={`Close ${title}`}>
              <X size={17} aria-hidden="true" />
            </button>
          </div>
          <div className="collab-dialog-content">{children}</div>
        </motion.div>
      )}
    </dialog>
  );
}
