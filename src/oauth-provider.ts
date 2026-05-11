/**
 * Minimal OAuth 2.0 authorization server for the FatSecret MCP custom connector.
 *
 * Designed for a single-user personal deployment:
 *   - One pre-registered OAuth client (CLIENT_ID + CLIENT_SECRET come from env).
 *   - "Always approve" authorization — there's no user-consent screen because
 *     the deployment serves a single end-user (the operator).
 *   - In-memory storage for codes / access tokens / refresh tokens; survives
 *     for the lifetime of the pod. A single-replica deployment is assumed.
 *   - PKCE is validated locally by the SDK (skipLocalPkceValidation=false).
 *
 * If you ever scale beyond one replica or need durability across restarts,
 * swap the Maps for Redis-backed stores. The provider interface stays the same.
 */

import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

interface CodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

interface AccessTokenEntry {
  clientId: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

interface RefreshTokenEntry {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

export interface MinimalOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Pre-registered redirect URIs. Exact-match per OAuth 2.1 (loopback gets port wildcard). */
  redirectUris: string[];
  /** Seconds. Defaults to 1 hour. */
  accessTokenTtl?: number;
  /** Seconds. Defaults to 30 days. */
  refreshTokenTtl?: number;
  /** Seconds. Defaults to 10 minutes. */
  codeTtl?: number;
  /** Optional human-readable name returned in client metadata. */
  clientName?: string;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const mintOpaque = () => randomBytes(32).toString('base64url');

export class MinimalOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  private readonly client: OAuthClientInformationFull;
  private readonly codes = new Map<string, CodeEntry>();
  private readonly accessTokens = new Map<string, AccessTokenEntry>();
  private readonly refreshTokens = new Map<string, RefreshTokenEntry>();

  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;
  private readonly codeTtl: number;

  constructor(opts: MinimalOAuthProviderOptions) {
    this.accessTokenTtl = opts.accessTokenTtl ?? 3600;
    this.refreshTokenTtl = opts.refreshTokenTtl ?? 60 * 60 * 24 * 30;
    this.codeTtl = opts.codeTtl ?? 600;

    this.client = {
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uris: opts.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: opts.clientName ?? 'FatSecret MCP',
    };

    this.clientsStore = {
      getClient: (id) => (id === this.client.client_id ? this.client : undefined),
      // No DCR — the client is fixed (the user enters its id/secret in claude.ai).
    };

    setInterval(() => this.cleanup(), 60_000).unref();
  }

  private cleanup() {
    const t = nowSec();
    for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
    for (const [k, v] of this.accessTokens) if (v.expiresAt < t) this.accessTokens.delete(k);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Single-user "always approve". Mint a code immediately and redirect.
    const code = mintOpaque();
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource,
      expiresAt: nowSec() + this.codeTtl,
    });
    const url = new URL(params.redirectUri);
    url.searchParams.set('code', code);
    if (params.state) url.searchParams.set('state', params.state);
    console.error(`[oauth] authorize → redirect to ${url.toString()}`);
    res.redirect(302, url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    if (entry.expiresAt < nowSec()) {
      this.codes.delete(authorizationCode);
      throw new Error('Authorization code expired');
    }
    if (entry.clientId !== client.client_id) throw new Error('Code does not match client');
    if (redirectUri && entry.redirectUri !== redirectUri) {
      throw new Error('redirect_uri mismatch');
    }
    // PKCE is verified by the SDK's token handler before this call.
    this.codes.delete(authorizationCode);

    return this.issueTokens(client.client_id, entry.scopes, entry.resource ?? resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry) throw new Error('Invalid refresh token');
    if (entry.clientId !== client.client_id) throw new Error('Refresh token does not match client');
    this.refreshTokens.delete(refreshToken);
    const effectiveScopes = scopes ?? entry.scopes;
    return this.issueTokens(client.client_id, effectiveScopes, entry.resource ?? resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.accessTokens.get(token);
    if (!entry) throw new Error('Invalid access token');
    if (entry.expiresAt < nowSec()) {
      this.accessTokens.delete(token);
      throw new Error('Access token expired');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
      resource: entry.resource,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    // Best-effort revoke — try both maps; ignore mismatches per RFC 7009.
    const accessEntry = this.accessTokens.get(request.token);
    if (accessEntry && accessEntry.clientId === client.client_id) {
      this.accessTokens.delete(request.token);
    }
    const refreshEntry = this.refreshTokens.get(request.token);
    if (refreshEntry && refreshEntry.clientId === client.client_id) {
      this.refreshTokens.delete(request.token);
    }
  }

  private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const accessToken = mintOpaque();
    const refreshToken = mintOpaque();
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: nowSec() + this.accessTokenTtl,
    });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtl,
      refresh_token: refreshToken,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }
}
