import crypto from 'crypto';

// SECURITY (pentest 2026-10-13): application API keys are never stored in plaintext.
// The database holds only the SHA-256 digest; the presented key is hashed and compared.
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

// New keys have 256 bits of randomness and a recognisable prefix for secret scanners.
export function generateApiKey(): string {
  return `kn_live_${crypto.randomBytes(32).toString('base64url')}`;
}
