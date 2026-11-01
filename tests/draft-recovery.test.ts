import test from 'node:test';
import assert from 'node:assert/strict';
import { canAcceptRecoveredDraft } from '../src/components/draft-recovery';

test('a recovered copy may clear only the exact reviewed draft sequence', () => {
  assert.equal(canAcceptRecoveredDraft(7, 7), true);
  assert.equal(canAcceptRecoveredDraft(8, 7), false, 'newer typing must stay in the original draft');
  assert.equal(canAcceptRecoveredDraft(undefined, 0), true, 'a clean source has no draft entry');
  assert.equal(canAcceptRecoveredDraft(undefined, 7), false);
});
