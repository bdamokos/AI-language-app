import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDismissedOnboarding, persistOnboardingDismissal, isOnboardingDismissal } from '../src/hooks/useOnboardingTour.js';

function cookieDocument(protocol = 'http:', initial = '') {
  let cookie = initial, written;
  return {
    location: { protocol },
    get cookie() { return cookie; },
    set cookie(value) { written = value; cookie = value.split(';')[0]; },
    get written() { return written; },
  };
}

test('Skip, close while running, and completion all dismiss either tour', () => {
  for (const event of [
    { action: 'skip', status: 'running' },
    { status: 'skipped' },
    { action: 'close', status: 'running', type: 'step:after' },
    { action: 'next', status: 'finished', type: 'tour:end' },
  ]) assert.equal(isOnboardingDismissal(event), true);
  for (const event of [{ action: 'next', status: 'running' }, { action: 'start', status: 'running' }, { action: 'reset', status: 'ready' }, { type: 'error:target_not_found' }]) {
    assert.equal(isOnboardingDismissal(event), false);
  }
});

test('a dismissed tour stays dismissed after reload on both local HTTP and hosted HTTPS', () => {
  for (const protocol of ['http:', 'https:']) {
    const document = cookieDocument(protocol);
    assert.equal(hasDismissedOnboarding(1, document), false);
    persistOnboardingDismissal(1, document);
    assert.equal(hasDismissedOnboarding(1, cookieDocument(protocol, document.cookie)), true);
    assert.match(document.written, /Path=\/; Max-Age=31536000; SameSite=Lax/);
    assert.equal(document.written.includes('; Secure'), protocol === 'https:');
  }
});

test('existing preferences remain compatible and malformed cookies do not break dismissal', () => {
  assert.equal(hasDismissedOnboarding(1, cookieDocument('http:', 'other=value; onboarding_version=v1')), true);
  assert.equal(hasDismissedOnboarding(2, cookieDocument('http:', 'onboarding_version=1')), false);
  assert.equal(hasDismissedOnboarding(1, cookieDocument('http:', 'onboarding_version=%broken')), false);
  const blocked = { get cookie() { throw new Error('Unavailable'); }, set cookie(value) { throw new Error('Unavailable'); } };
  assert.equal(hasDismissedOnboarding(1, blocked), false);
  assert.doesNotThrow(() => persistOnboardingDismissal(1, blocked));
});
