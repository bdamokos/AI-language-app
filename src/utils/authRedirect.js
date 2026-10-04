export function authRedirectUrl(value, currentOrigin) {
  if (typeof value !== 'string' || !value) {
    throw new Error('The sign-in link is unavailable. Please contact the site owner.');
  }
  const current = new URL(currentOrigin);
  const destination = new URL(value, current);
  const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const localTest = current.protocol === 'http:' && destination.protocol === 'http:'
    && loopback(current.hostname) && loopback(destination.hostname);
  if ((destination.protocol !== 'https:' && !localTest) || destination.username || destination.password) {
    throw new Error('The sign-in link is invalid. Please contact the site owner.');
  }
  return destination.href;
}
