const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const MAX_USERINFO_BYTES = 32768;

/** Validate verified Google OAuth userinfo payload. */
export function validateGoogleIdentity(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    data.email_verified !== true ||
    typeof data.email !== 'string' ||
    data.email.length > 254 ||
    !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(
      data.email,
    ) ||
    typeof data.sub !== 'string' ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(data.sub)
  ) {
    return null;
  }
  return { email: data.email, subject: data.sub };
}

/** Best-effort lookup of verified email and subject for an OAuth access token. */
export async function fetchGoogleIdentity(
  accessToken,
  { fetchImpl = fetch, signal, timeoutMs = 8000 } = {},
) {
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    /[\r\n]/.test(accessToken)
  ) {
    return null;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: combinedSignal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {}
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const data = await response.json();
      return validateGoogleIdentity(data);
    }
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_USERINFO_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return validateGoogleIdentity(parsed);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
