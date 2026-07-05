/**
 * Minimal OAuth 2.0 authorization server for a single-user remote MCP connector.
 *
 * Generic — no upstream-specific logic. Reusable across MCP servers (see the
 * remote-mcp-wrap skill). State (codes / access tokens / refresh tokens) lives
 * in a pluggable OAuthStore: in-memory by default, or Redis-backed (set
 * REDIS_URL) so the OAuth state survives pod rollouts and claude.ai is not forced
 * to re-authenticate after every deploy.
 *
 *   - One pre-registered OAuth client (CLIENT_ID + CLIENT_SECRET from env).
 *   - "Always approve" authorization — single end-user, no consent UI.
 *   - PKCE is validated locally by the SDK (skipLocalPkceValidation=false).
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
import type { OAuthStore } from './oauth-store.js';

interface CodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface AccessTokenEntry {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface RefreshTokenEntry {
  clientId: string;
  scopes: string[];
  resource?: string;
}

export interface MinimalOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Pre-registered redirect URIs. Exact-match per OAuth 2.1 (loopback gets port wildcard). */
  redirectUris: string[];
  /** Persistent or in-memory storage for codes/tokens. */
  store: OAuthStore;
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
  private readonly store: OAuthStore;

  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;
  private readonly codeTtl: number;

  constructor(opts: MinimalOAuthProviderOptions) {
    this.store = opts.store;
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
      client_name: opts.clientName ?? 'MCP',
    };

    this.clientsStore = {
      getClient: (id) => (id === this.client.client_id ? this.client : undefined),
      // No DCR — the client is fixed (the user enters its id/secret in claude.ai).
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Single-user "always approve". Mint a code immediately and redirect.
    const code = mintOpaque();
    const entry: CodeEntry = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      expiresAt: nowSec() + this.codeTtl,
    };
    await this.store.set('code', code, entry, this.codeTtl);
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
    const entry = await this.store.get<CodeEntry>('code', authorizationCode);
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
    const entry = await this.store.get<CodeEntry>('code', authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    if (entry.expiresAt < nowSec()) {
      await this.store.del('code', authorizationCode);
      throw new Error('Authorization code expired');
    }
    if (entry.clientId !== client.client_id) throw new Error('Code does not match client');
    if (redirectUri && entry.redirectUri !== redirectUri) {
      throw new Error('redirect_uri mismatch');
    }
    // PKCE is verified by the SDK's token handler before this call.
    await this.store.del('code', authorizationCode);

    return this.issueTokens(client.client_id, entry.scopes, entry.resource ?? resource?.toString());
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = await this.store.get<RefreshTokenEntry>('refresh', refreshToken);
    if (!entry) throw new Error('Invalid refresh token');
    if (entry.clientId !== client.client_id) throw new Error('Refresh token does not match client');
    await this.store.del('refresh', refreshToken);
    const effectiveScopes = scopes ?? entry.scopes;
    return this.issueTokens(
      client.client_id,
      effectiveScopes,
      entry.resource ?? resource?.toString(),
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = await this.store.get<AccessTokenEntry>('access', token);
    if (!entry) throw new Error('Invalid access token');
    if (entry.expiresAt < nowSec()) {
      await this.store.del('access', token);
      throw new Error('Access token expired');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
      resource: entry.resource ? new URL(entry.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    // Best-effort revoke — try both kinds; ignore mismatches per RFC 7009.
    const accessEntry = await this.store.get<AccessTokenEntry>('access', request.token);
    if (accessEntry && accessEntry.clientId === client.client_id) {
      await this.store.del('access', request.token);
    }
    const refreshEntry = await this.store.get<RefreshTokenEntry>('refresh', request.token);
    if (refreshEntry && refreshEntry.clientId === client.client_id) {
      await this.store.del('refresh', request.token);
    }
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
  ): Promise<OAuthTokens> {
    const accessToken = mintOpaque();
    const refreshToken = mintOpaque();
    const accessEntry: AccessTokenEntry = {
      clientId,
      scopes,
      resource,
      expiresAt: nowSec() + this.accessTokenTtl,
    };
    const refreshEntry: RefreshTokenEntry = { clientId, scopes, resource };
    await this.store.set('access', accessToken, accessEntry, this.accessTokenTtl);
    // Intentional behaviour change vs. the previous in-memory implementation,
    // where refresh tokens never expired (the old Map was never cleaned up).
    // Refresh tokens now carry refreshTokenTtl (default 30 days) and are rotated
    // on every refresh — each exchangeRefreshToken issues a fresh token with a
    // fresh 30-day window. So an actively-used connector never expires; the TTL
    // only forces re-auth after ~30 days of total inactivity. This is better
    // hygiene than an immortal refresh token persisted in Redis.
    await this.store.set('refresh', refreshToken, refreshEntry, this.refreshTokenTtl);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtl,
      refresh_token: refreshToken,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }
}
