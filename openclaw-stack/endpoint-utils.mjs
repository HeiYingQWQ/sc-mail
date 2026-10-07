const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'sc-mail-openclaw']);
const API_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal', 'sc-mail-api']);

export function gatewayBaseUrl(values) {
  const raw = values.get('OPENCLAW_INTERNAL_URL') || `http://host.docker.internal:${values.get('OPENCLAW_GATEWAY_PORT') || '18789'}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !LOCAL_HTTP_HOSTS.has(url.hostname))) {
    throw new Error('OPENCLAW_INTERNAL_URL must be a local HTTP or HTTPS gateway origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

export function mailApiUrl(openclaw, mail) {
  const raw = openclaw.get('AI_MAIL_API_URL') || `http://host.docker.internal:${mail.get('PORT') || '3000'}/api/v1`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/api/v1') || (url.protocol === 'http:' && !API_HTTP_HOSTS.has(url.hostname))) {
    throw new Error('AI_MAIL_API_URL must be a private HTTP or HTTPS API v1 URL without credentials, query, or fragment.');
  }
  return url.toString().replace(/\/$/, '');
}
