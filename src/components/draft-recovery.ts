/** A recovery copy may clear only the exact draft the person reviewed. */
export function canAcceptRecoveredDraft(currentSequence: number | undefined, reviewedSequence: number): boolean {
  return (currentSequence ?? 0) === reviewedSequence;
}
