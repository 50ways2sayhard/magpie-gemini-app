import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../core/src/gateway/quota-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../core/src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../core/src/gateway/subscription.mjs';
import { PROVIDER_ID, SUBSCRIPTION_LABELS } from './constants.mjs';
import { fetchGoogleIdentity as defaultFetchGoogleIdentity } from './identity.mjs';
import {
  dynamicHttp2Connect,
  refreshOAuthCredential as defaultRefreshOAuthCredential,
} from './oauth.mjs';

export function inferWindowSpan(row) {
  const parts = [row?.label || ''];
  if (Array.isArray(row?.helpItems)) {
    for (const item of row.helpItems) {
      if (item?.label) parts.push(item.label);
      if (item?.description) parts.push(item.description);
    }
  }
  const text = parts.join(' ');
  if (/5[- ]?hour|current usage|5\s*小时|5\s*小時/i.test(text)) {
    return 5 * 3600;
  }
  if (/week|7[- ]?day|每周|每週|7\s*天/i.test(text)) {
    return 7 * 86400;
  }
  if (/24[- ]?hour|daily|\bday\b|每日/i.test(text)) {
    return 86400;
  }
  return 0;
}

export function formatMagpieUsage(decodedUsage, subscription, auth) {
  const tier =
    subscription?.tier && subscription.tier !== 'unknown'
      ? subscription.tier
      : auth?.subscriptionTier;
  const plan =
    tier && tier !== 'unknown' ? SUBSCRIPTION_LABELS[tier] || tier : '';
  const user = auth?.email || auth?.accountId || '';

  const rows = Array.isArray(decodedUsage?.usageRows)
    ? decodedUsage.usageRows
    : [];
  const windows = rows.map((row) => {
    const win = {
      name: row.label || 'Usage',
    };
    if (row.providerPercent !== null && Number.isFinite(row.providerPercent)) {
      win.used = Math.max(0, Math.round(row.providerPercent * 100) / 100);
    }
    if (row.providerTimestamp) {
      win.resetsAt = row.providerTimestamp;
    }
    const span = inferWindowSpan(row);
    if (span > 0) {
      win.span = span;
    }
    return win;
  });

  return {
    ...(plan ? { plan } : {}),
    ...(user ? { user } : {}),
    windows,
  };
}

export function createUsageHandler({ client, deps = {} } = {}) {
  const fetchUsageFn = deps.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeUsageFn = deps.decodeUsageInfo || defaultDecodeUsageInfo;
  const decodeSubFn = deps.decodeSubscription || defaultDecodeSubscription;
  const refreshFn = deps.refreshOAuthCredential || defaultRefreshOAuthCredential;
  const fetchIdentityFn = deps.fetchGoogleIdentity || defaultFetchGoogleIdentity;
  const connect = deps.connect || dynamicHttp2Connect;

  return async function usage(getAuth, _provider, usageOpts) {
    const signal = usageOpts?.signal;
    const auth = await getAuth();
    if (!auth || typeof auth.access !== 'string' || !auth.access) {
      return { error: 'Not signed in', windows: [], signIn: 'expired' };
    }

    let currentAuth = { ...auth };
    let renewed = false;
    let payloadResult;

    try {
      payloadResult = await fetchUsageFn(currentAuth.access, {
        signal,
        timeoutMs: 10000,
        connect,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === 'QUOTA_AUTH_REJECTED' && currentAuth.refresh) {
        let refreshed;
        try {
          refreshed = await refreshFn(currentAuth, { signal, deps });
        } catch (refreshError) {
          if (signal?.aborted) throw refreshError;
          return {
            error: refreshError?.message || 'Google sign-in expired; please sign in again.',
            windows: [],
            ...(refreshError?.signIn === 'expired' ? { signIn: 'expired' } : {}),
          };
        }
        currentAuth = {
          ...currentAuth,
          type: 'oauth',
          ...refreshed,
        };
        renewed = true;
        await client?.auth?.set?.({
          path: { id: PROVIDER_ID },
          body: currentAuth,
        });
        try {
          payloadResult = await fetchUsageFn(currentAuth.access, {
            signal,
            timeoutMs: 10000,
            connect,
          });
        } catch (retryError) {
          if (signal?.aborted) throw retryError;
          if (retryError?.code === 'QUOTA_AUTH_REJECTED') {
            return {
              error: 'Google Gemini refused the credential; please sign in again.',
              windows: [],
              signIn: 'expired',
            };
          }
          return {
            error: retryError?.message || retryError?.code || 'Failed to fetch Gemini usage',
            windows: [],
            ...(renewed ? { signIn: 'renewed' } : {}),
          };
        }
      } else {
        return {
          error: error?.message || error?.code || 'Failed to fetch Gemini usage',
          windows: [],
          ...(error?.code === 'QUOTA_AUTH_REJECTED' ? { signIn: 'expired' } : {}),
        };
      }
    }

    const decodedUsage = decodeUsageFn(payloadResult.payload);
    let subscription = null;
    try {
      subscription = decodeSubFn(payloadResult.payload);
    } catch {}

    let authChanged = false;
    if (
      subscription?.tier &&
      subscription.tier !== 'unknown' &&
      subscription.tier !== currentAuth.subscriptionTier
    ) {
      currentAuth = { ...currentAuth, subscriptionTier: subscription.tier };
      authChanged = true;
    }

    if (!currentAuth.accountId || !currentAuth.email || !currentAuth.uid) {
      const identity = await fetchIdentityFn(currentAuth.access, { signal }).catch(
        (err) => {
          if (signal?.aborted) throw err;
          return null;
        },
      );
      if (identity) {
        currentAuth = {
          ...currentAuth,
          accountId: identity.email,
          email: identity.email,
          uid: identity.subject,
        };
        authChanged = true;
      }
    }

    if (authChanged) {
      await client?.auth?.set?.({
        path: { id: PROVIDER_ID },
        body: currentAuth,
      });
    }

    const formatted = formatMagpieUsage(decodedUsage, subscription, currentAuth);
    return {
      ...formatted,
      ...(renewed ? { signIn: 'renewed' } : {}),
    };
  };
}
