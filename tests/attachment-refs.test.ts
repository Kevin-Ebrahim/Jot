import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentRewriter } from '../src/lib/attachment-refs';

test('a large ID map rewrites all known references in one scan, preserving cross-note and unknown references', () => {
  const ids = new Map<string, string>();
  for (let i = 0; i < 10_000; i++) ids.set(`id-${String(i).padStart(5, '0')}`, `attachment:new-${i}`);
  ids.set('prefix', 'attachment:short');
  ids.set('prefix-long', 'attachment:long');
  ids.set('unicode-📝', 'attachment:unicode-copy');
  const rewrite = createAttachmentRewriter(ids);
  const body = '![one](attachment:id-00000) [cross-note](attachment:id-09999) attachment:prefix-long attachment:prefix attachment:unicode-📝 attachment:unknown';
  assert.equal(rewrite(body), '![one](attachment:new-0) [cross-note](attachment:new-9999) attachment:long attachment:short attachment:unicode-copy attachment:unknown');
  assert.equal(rewrite('unchanged text'), 'unchanged text');
});
