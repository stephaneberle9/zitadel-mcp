/**
 * Zitadel Management API Client
 * JWT bearer token authentication via service account
 *
 * Security notes:
 * - Private key is imported once as CryptoKey and cached for the server lifetime (REM-42)
 * - OAuth scope is minimal: `openid urn:zitadel:iam:org:project:id:zitadel:aud` (REM-23)
 *   This scope grants access to Zitadel's Management API only. Actual permissions are
 *   determined by the service account's role (should be ORG_OWNER, NOT IAM_ADMIN).
 *   The MCP server almost exclusively uses org-scoped Management API endpoints
 *   (/management/v1/*, /v2/*). The one deliberate exception is the SMTP tools
 *   (src/tools/smtp.ts), which configure the INSTANCE-level notification provider via the
 *   Admin API (/admin/v1/email/*) and therefore require an IAM-level manager grant on the
 *   service account; see that module's header and the README security section.
 * - Access tokens are cached in memory and never logged or returned to the MCP client
 * - All communication with Zitadel uses HTTPS (enforced by issuer URL validation)
 *
 * Token storage assumption (REM-41):
 * This server uses stdio transport — tokens stay in-process and are never transmitted
 * over a network to the MCP client. The private key is loaded from an environment
 * variable (base64-encoded) and decoded only in memory. If switching to HTTP/SSE
 * transport, additional measures (TLS, token binding) would be required.
 */

import { SignJWT, importPKCS8, type KeyLike } from 'jose';
import { createPrivateKey } from 'crypto';
import type { ZitadelConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Summarize an error response body for the server log.
 *
 * Both failure paths below already fetched the body; without this it was parsed or read and
 * then dropped, so the log showed a bare status and the one string naming the actual problem
 * never reached the operator. OAuth errors carry `error` / `error_description`
 * ("invalid_grant" / "invalid assertion" for a service-account id that is not the user's
 * numeric ID, say) and Zitadel API errors carry `message`. Anything else is logged as a
 * truncated snippet, so an HTML error page from a proxy cannot flood the log.
 */
function describeErrorBody(body: string): Record<string, string> {
  const trimmed = body.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: string;
      error_description?: string;
      message?: string;
    };
    const detail: Record<string, string> = {};
    if (parsed.error) detail['error'] = parsed.error;
    if (parsed.error_description) detail['errorDescription'] = parsed.error_description;
    if (parsed.message) detail['message'] = parsed.message;
    if (Object.keys(detail).length > 0) return detail;
  } catch {
    // Not JSON — fall through to the raw snippet.
  }

  return { body: trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed };
}

export class ZitadelClient {
  private config: ZitadelConfig;
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private cachedCryptoKey: KeyLike | null = null;

  constructor(config: ZitadelConfig) {
    this.config = config;
  }

  getConfig(): ZitadelConfig {
    return this.config;
  }

  clearTokenCache(): void {
    this.cachedToken = null;
  }

  /**
   * Import the private key as a CryptoKey once and cache it.
   * Handles both PKCS#1 (RSA) and PKCS#8 PEM formats.
   */
  private async getCryptoKey(): Promise<KeyLike> {
    if (this.cachedCryptoKey) {
      return this.cachedCryptoKey;
    }

    const { serviceAccountPrivateKey } = this.config;

    // Accept either a raw PEM or a base64-encoded PEM. Base64 decoding never throws,
    // so a raw PEM run through Buffer.from(_, 'base64') is silently corrupted into
    // non-PEM bytes — detect a PEM up front instead of relying on try/catch.
    let privateKeyPem = serviceAccountPrivateKey;
    if (!privateKeyPem.includes('BEGIN')) {
      const decoded = Buffer.from(serviceAccountPrivateKey, 'base64').toString('utf-8');
      if (decoded.includes('BEGIN')) {
        privateKeyPem = decoded;
      }
    }

    // Restore real newlines when the PEM was stored single-line with escaped "\n"
    // (e.g. the JSON key's "key" field pasted verbatim into an unquoted env var).
    if (privateKeyPem.includes('\\n')) {
      privateKeyPem = privateKeyPem.replace(/\\n/g, '\n');
    }

    // Convert PKCS#1 to PKCS#8 if needed (jose requires PKCS#8)
    let pkcs8Pem: string;
    if (privateKeyPem.includes('BEGIN RSA PRIVATE KEY')) {
      const keyObject = createPrivateKey(privateKeyPem);
      pkcs8Pem = keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
    } else {
      pkcs8Pem = privateKeyPem;
    }

    this.cachedCryptoKey = await importPKCS8(pkcs8Pem, 'RS256');
    return this.cachedCryptoKey;
  }

  /**
   * Generate a JWT assertion for the service account
   * Uses cached CryptoKey to avoid repeated key import overhead.
   */
  private async generateJwtAssertion(): Promise<string> {
    const { serviceAccountUserId, serviceAccountKeyId, issuer } = this.config;
    const privateKey = await this.getCryptoKey();
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: serviceAccountKeyId })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setIssuer(serviceAccountUserId)
      .setSubject(serviceAccountUserId)
      .setAudience(issuer)
      .sign(privateKey);
  }

  /**
   * Exchange JWT assertion for an access token (cached for ~1 hour)
   *
   * Scope: `openid urn:zitadel:iam:org:project:id:zitadel:aud`
   * This is the minimum scope required to access the Management API.
   * The service account's role assignment controls what operations are allowed.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s safety buffer)
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60000) {
      return this.cachedToken.token;
    }

    const jwtAssertion = await this.generateJwtAssertion();
    const tokenUrl = `${this.config.issuer}/oauth/v2/token`;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwtAssertion,
        scope: 'openid urn:zitadel:iam:org:project:id:zitadel:aud',
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Token exchange failed', {
        status: response.status,
        ...describeErrorBody(errorBody),
      });
      throw new Error(`Failed to obtain access token (HTTP ${response.status})`);
    }

    const data = await response.json() as { access_token: string; expires_in?: number };

    this.cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };

    return data.access_token;
  }

  /**
   * Make an authenticated request to the Zitadel Management API
   * Includes x-zitadel-orgid header, handles 401 cache clearing and empty responses
   *
   * `meta.exposeErrorDetail` opts a single call into surfacing ZITADEL's own error
   * `message` on failure (appended to the generic text). Off by default so we don't leak
   * API internals; enable it only where the upstream message is the useful, non-sensitive
   * payload — e.g. the SMTP-test endpoint, whose failure reason describes the *relay*
   * configuration ("could not add smtp auth…"), not ZITADEL internals.
   */
  async request<T>(
    path: string,
    options: RequestInit = {},
    meta: { exposeErrorDetail?: boolean } = {}
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.config.issuer}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-zitadel-orgid': this.config.orgId,
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      // Read the body as text, so a non-JSON error page is still loggable.
      const errorBody = await response.text();
      const errorDetail = describeErrorBody(errorBody);

      // Log full error details internally
      logger.error('Zitadel API error', {
        status: response.status,
        path,
        ...errorDetail,
      });

      // Clear token cache on auth failures
      if (response.status === 401) {
        this.clearTokenCache();
      }

      // Return generic message — don't leak Zitadel API internals.
      // The numeric status is attached (err.status) so callers can branch on it
      // (e.g. 404 → fall back to a v1 endpoint, 403 → degrade gracefully) without
      // parsing the message string. The status itself is not sensitive.
      const status = response.status;
      let message: string;
      if (status === 404) {
        message = 'The requested resource was not found.';
      } else if (status === 403) {
        message = 'Permission denied for this operation.';
      } else if (status === 409) {
        message = 'A conflict occurred — the resource may already exist.';
      } else if (status === 429) {
        message = 'Rate limit exceeded. Please try again later.';
      } else {
        message = `Operation failed (HTTP ${status}). Check server logs for details.`;
      }
      // Opt-in: append the upstream reason where it is the point of the call (see doc above).
      if (meta.exposeErrorDetail && errorDetail['message']) {
        message += ` — ${errorDetail['message']}`;
      }
      const err = new Error(message) as Error & { status?: number };
      err.status = status;
      throw err;
    }

    // Handle empty responses (e.g. DELETE operations)
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}
