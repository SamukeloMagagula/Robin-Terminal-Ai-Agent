/** A short, human-readable reason for a failed provider HTTP request, keyed off the status code. */
export function httpErrorDetail(status: number): string {
  if (status === 402) return 'insufficient credits/quota';
  if (status === 401 || status === 403) return 'authentication/authorization failed';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'server error';
  return 'request failed';
}

export function describeChatError(providerLabel: string, status: number): string {
  return `${providerLabel} chat request failed: ${status} (${httpErrorDetail(status)})`;
}
