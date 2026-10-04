import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTIONS, STATUS } from 'react-joyride';

const COOKIE_NAME = 'onboarding_version';

export function hasDismissedOnboarding(version, document = globalThis.document) {
  try {
    const pair = document?.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
    const saved = pair ? decodeURIComponent(pair.slice(COOKIE_NAME.length + 1)) : '';
    return saved.replace(/^v/, '') === String(version);
  } catch { return false; }
}

export function persistOnboardingDismissal(version, document = globalThis.document) {
  if (!document) return;
  try {
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(String(version))}; Path=/; Max-Age=31536000; SameSite=Lax${document.location?.protocol === 'https:' ? '; Secure' : ''}`;
  } catch { /* Dismissal still takes effect when browser storage is unavailable. */ }
}

export function isOnboardingDismissal({ action, status } = {}) {
  // Joyride's close action can arrive with status=running before tour:end.
  return action === ACTIONS.CLOSE || action === ACTIONS.SKIP || status === STATUS.SKIPPED || status === STATUS.FINISHED;
}

export default function useOnboardingTour({ version, phase, ready }) {
  const [dismissed, setDismissed] = useState(() => hasDismissedOnboarding(version));
  const dismissedRef = useRef(dismissed);
  const [activeTour, setActiveTour] = useState(null);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    setActiveTour(current => current && current !== phase ? null : current);
  }, [phase]);

  useEffect(() => {
    if (dismissed || activeTour || !ready) return;
    const timer = setTimeout(() => {
      if (!dismissedRef.current) setActiveTour(phase);
    }, 300);
    return () => clearTimeout(timer);
  }, [dismissed, activeTour, ready, phase]);

  const onCallback = useCallback(data => {
    if (!isOnboardingDismissal(data)) return;
    // Update the ref before React commits so a queued auto-start cannot reopen
    // the tour. Both pre-lesson and lesson tours share the same dismissal.
    dismissedRef.current = true;
    setDismissed(true);
    setActiveTour(null);
    persistOnboardingDismissal(version);
  }, [version]);

  const start = useCallback(() => {
    // Manual Help is explicit consent to reopen; leave automatic dismissal
    // persisted so a later reload still stays quiet.
    setRunId(value => value + 1);
    setActiveTour(phase);
  }, [phase]);

  return { activeTour, runId, onCallback, start };
}
