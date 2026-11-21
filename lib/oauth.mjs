import http2 from 'node:http2';
import {
  startLoopbackLogin as defaultStartLoopbackLogin,
  refreshNativeCredential as defaultRefreshNativeCredential,
} from '../core/native-wire/oauth-loopback.mjs';
import { DEFAULT_OAUTH_PROFILE } from '../core/src/gateway/oauth-client-defaults.mjs';
import { acceptGoogleMainTerms as defaultAcceptGoogleMainTerms, termsRpc as defaultTermsRpc } from '../core/src/gateway/terms.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../core/src/gateway/quota-transport.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../core/src/gateway/subscription.mjs';
import { fetchGoogleIdentity as defaultFetchGoogleIdentity } from './identity.mjs';

const FLEXIBLE_API_SCOPE = 'https://www.googleapis.com/auth/flexible-api';
const FALLBACK_REFRESH_SCOPES = [
  'https://www.googleapis.com/auth/assistant',
  'https://www.googleapis.com/auth/gemini',
];

export function resolveOAuthConfig({
  defaultProfile = DEFAULT_OAUTH_PROFILE,
  env = process.env,
} = {}) {
  const envClientId =
    typeof env?.GEMINI_OAUTH_CLIENT_ID === 'string'
      ? env.GEMINI_OAUTH_CLIENT_ID.trim()
      : '';
  const hasEnvClientId = envClientId.length > 0;
  const clientId = hasEnvClientId
    ? envClientId
    : typeof defaultProfile?.clientId === 'string'
      ? defaultProfile.clientId.trim()
      : '';
  if (!clientId) {
    throw new Error('OAuth client ID is not configured; set GEMINI_OAUTH_CLIENT_ID.');
  }
  const envClientSecret =
    typeof env?.GEMINI_OAUTH_CLIENT_SECRET === 'string'
      ? env.GEMINI_OAUTH_CLIENT_SECRET.trim()
      : '';
  const clientSecret = hasEnvClientId
    ? envClientSecret
    : envClientSecret ||
      (typeof defaultProfile?.clientSecret === 'string'
        ? defaultProfile.clientSecret.trim()
        : '');
  const refreshScopes =
    Array.isArray(defaultProfile?.scopes) && defaultProfile.scopes.length > 0
      ? [...defaultProfile.scopes]
      : [...FALLBACK_REFRESH_SCOPES];
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes: [FLEXIBLE_API_SCOPE],
    refreshScopes,
    port: 0,
    listenHost: '127.0.0.1',
    redirectHost: 'localhost',
    nativeLoopback: true,
    forceConsent: true,
  };
}

export function computeExpiresAtMs(expiresInSeconds) {
  const ttlSeconds =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds
      : 3600;
  return Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
}

export function dynamicHttp2Connect(...args) {
  return http2.connect(...args);
}

export async function detectSubscriptionTier(
  accessToken,
  {
    signal,
    fetchUsage = defaultFetchGoogleUsageInfo,
    decodeSub = defaultDecodeSubscription,
    connect = dynamicHttp2Connect,
  } = {},
) {
  try {
    const { payload } = await fetchUsage(accessToken, {
      signal,
      timeoutMs: 8000,
      connect,
    });
    const sub = decodeSub(payload);
    return typeof sub?.tier === 'string' && sub.tier ? sub.tier : 'unknown';
  } catch (error) {
    if (signal?.aborted) throw error;
    return 'unknown';
  }
}

async function finalizeSignIn(tokens, config, { signal, deps = {} } = {}) {
  if (!tokens || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) {
    return {
      type: 'failed',
      error: 'Google OAuth login did not return a refresh token.',
    };
  }

  const refreshFn = deps.refreshNativeCredential || defaultRefreshNativeCredential;
  const acceptTermsFn = deps.acceptGoogleMainTerms || defaultAcceptGoogleMainTerms;
  const termsRpcFn =
    deps.termsRpc ||
    ((tok, rpc, payload, opts) =>
      defaultTermsRpc(tok, rpc, payload, { ...opts, connect: dynamicHttp2Connect }));
  const fetchIdentityFn = deps.fetchGoogleIdentity || defaultFetchGoogleIdentity;
  const fetchUsageFn = deps.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeSubFn = deps.decodeSubscription || defaultDecodeSubscription;
  const connect = deps.connect || dynamicHttp2Connect;

  const scoped = await refreshFn(config, tokens.refreshToken, { signal });

  try {
    await acceptTermsFn(scoped.accessToken, {
      signal,
      rpc: termsRpcFn,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = typeof error?.code === 'string' ? error.code : '';
    if (!code.startsWith('TOS_')) {
      return { type: 'failed', error: error?.message || 'Terms acceptance failed' };
    }
  }

  const [identity, subscriptionTier] = await Promise.all([
    fetchIdentityFn(scoped.accessToken, { signal }).catch((err) => {
      if (signal?.aborted) throw err;
      return null;
    }),
    detectSubscriptionTier(scoped.accessToken, {
      signal,
      fetchUsage: fetchUsageFn,
      decodeSub: decodeSubFn,
      connect,
    }),
  ]);

  return {
    type: 'success',
    refresh: scoped.refreshToken || tokens.refreshToken,
    access: scoped.accessToken,
    expires: computeExpiresAtMs(
      scoped.expiresInSeconds ?? tokens.expiresInSeconds,
    ),
    ...(identity
      ? {
          accountId: identity.email,
          email: identity.email,
          uid: identity.subject,
        }
      : {}),
    ...(subscriptionTier !== 'unknown' ? { subscriptionTier } : {}),
  };
}

function formatSignInError(error) {
  const msg = typeof error?.message === 'string' ? error.message.trim() : '';
  return msg || 'Google sign-in failed.';
}

export function createOAuthMethods(deps = {}) {
  const startLoopback = deps.startLoopbackLogin || defaultStartLoopbackLogin;

  async function startSession(signal) {
    const config = resolveOAuthConfig({
      defaultProfile: deps.defaultProfile || DEFAULT_OAUTH_PROFILE,
      env: deps.env || process.env,
    });
    const session = await startLoopback(config, { signal });
    return { config, session };
  }

  const browserMethod = {
    type: 'oauth',
    label: 'Sign in with Google (Browser)',
    async authorize(_inputs, authOpts) {
      let config;
      let session;
      try {
        ({ config, session } = await startSession(authOpts?.signal));
      } catch (error) {
        return { type: 'failed', error: formatSignInError(error) };
      }

      return {
        url: session.authorizationUrl,
        instructions:
          'Complete Google sign-in in your browser. Magpie will receive the loopback callback automatically.',
        method: 'auto',
        async callback(_unused, cbOpts) {
          const sig = cbOpts?.signal;
          const onAbort = () => {
            try {
              session.close('LOGIN_CLOSED');
            } catch {}
          };
          if (sig?.aborted) {
            onAbort();
            return { type: 'failed', error: 'Sign-in cancelled.' };
          }
          sig?.addEventListener('abort', onAbort, { once: true });
          try {
            const tokens = await session.done;
            return await finalizeSignIn(tokens, config, { signal: sig, deps });
          } catch (error) {
            return { type: 'failed', error: formatSignInError(error) };
          } finally {
            sig?.removeEventListener('abort', onAbort);
            try {
              session.close('LOGIN_CLOSED');
            } catch {}
          }
        },
      };
    },
  };

  const manualMethod = {
    type: 'oauth',
    label: 'Sign in with Google (Paste redirect URL / SSH)',
    async authorize(_inputs, authOpts) {
      let config;
      let session;
      try {
        ({ config, session } = await startSession(authOpts?.signal));
      } catch (error) {
        return { type: 'failed', error: formatSignInError(error) };
      }

      return {
        url: session.authorizationUrl,
        instructions:
          'Open the Google sign-in URL in any browser, approve sign-in, then copy and paste the final http://localhost:... redirect URL here.',
        method: 'code',
        async callback(rawUrl, cbOpts) {
          const sig = cbOpts?.signal;
          const onAbort = () => {
            try {
              session.close('LOGIN_CLOSED');
            } catch {}
          };
          if (sig?.aborted) {
            onAbort();
            return { type: 'failed', error: 'Sign-in cancelled.' };
          }
          sig?.addEventListener('abort', onAbort, { once: true });
          try {
            if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
              return {
                type: 'failed',
                error: 'Please paste the complete http://localhost:... redirect URL.',
              };
            }
            const tokens = await session.completeCallbackUrl(rawUrl);
            return await finalizeSignIn(tokens, config, { signal: sig, deps });
          } catch (error) {
            return { type: 'failed', error: formatSignInError(error) };
          } finally {
            sig?.removeEventListener('abort', onAbort);
            try {
              session.close('LOGIN_CLOSED');
            } catch {}
          }
        },
      };
    },
  };

  return [browserMethod, manualMethod];
}

export function isExpiredOAuthError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'invalid_grant' || code === 'unauthorized_client' || code === 'access_denied') {
    return true;
  }
  const msg = typeof error?.message === 'string' ? error.message : '';
  return /invalid_grant|unauthorized_client|token has been expired or revoked/i.test(msg);
}

export async function refreshOAuthCredential(auth, { signal, deps = {} } = {}) {
  if (!auth || typeof auth.refresh !== 'string' || !auth.refresh) {
    throw Object.assign(new Error('Missing Google OAuth refresh token.'), {
      signIn: 'expired',
    });
  }
  const config = resolveOAuthConfig({
    defaultProfile: deps.defaultProfile || DEFAULT_OAUTH_PROFILE,
    env: deps.env || process.env,
  });
  const refreshFn = deps.refreshNativeCredential || defaultRefreshNativeCredential;
  const fetchIdentityFn = deps.fetchGoogleIdentity || defaultFetchGoogleIdentity;
  const fetchUsageFn = deps.fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const decodeSubFn = deps.decodeSubscription || defaultDecodeSubscription;
  const connect = deps.connect || dynamicHttp2Connect;

  let refreshed;
  try {
    refreshed = await refreshFn(config, auth.refresh, { signal });
  } catch (error) {
    if (isExpiredOAuthError(error)) {
      throw Object.assign(
        new Error('Google OAuth sign-in expired; please sign in again.'),
        { signIn: 'expired' },
      );
    }
    throw error;
  }

  const needsIdentity = !auth.accountId || !auth.email || !auth.uid;
  const [identity, detectedTier] = await Promise.all([
    needsIdentity
      ? fetchIdentityFn(refreshed.accessToken, { signal }).catch((err) => {
          if (signal?.aborted) throw err;
          return null;
        })
      : Promise.resolve(null),
    detectSubscriptionTier(refreshed.accessToken, {
      signal,
      fetchUsage: fetchUsageFn,
      decodeSub: decodeSubFn,
      connect,
    }),
  ]);

  const subscriptionTier =
    detectedTier !== 'unknown' ? detectedTier : auth.subscriptionTier;

  return {
    access: refreshed.accessToken,
    refresh: refreshed.refreshToken || auth.refresh,
    expires: computeExpiresAtMs(refreshed.expiresInSeconds),
    ...(subscriptionTier ? { subscriptionTier } : {}),
    ...(identity
      ? {
          accountId: identity.email,
          email: identity.email,
          uid: identity.subject,
        }
      : {}),
  };
}
