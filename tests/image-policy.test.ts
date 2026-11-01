import test from 'node:test';
import assert from 'node:assert/strict';
import { canLoadRemoteImage, isRemoteImageSource, remoteImageKey } from '../src/components/image-policy';

test('external images require explicit consent for the exact note and URL', () => {
  const allowed = new Set<string>();
  const image = 'https://tracker.example/pixel?id=1';
  assert.equal(canLoadRemoteImage('note-a', image, allowed), false);
  allowed.add(remoteImageKey('note-a', image));
  assert.equal(canLoadRemoteImage('note-a', image, allowed), true);
  assert.equal(canLoadRemoteImage('note-b', image, allowed), false);
  assert.equal(canLoadRemoteImage('note-a', 'https://tracker.example/other', allowed), false);
});

test('relative images are gated and executable or data schemes are rejected', () => {
  assert.equal(isRemoteImageSource('/image.png'), true);
  assert.equal(canLoadRemoteImage('a', '/image.png', new Set()), false);
  for (const source of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:https://example.test/id', 'attachment:id']) {
    assert.equal(isRemoteImageSource(source), false);
    assert.equal(canLoadRemoteImage('a', source, new Set([remoteImageKey('a', source)])), false);
  }
});
