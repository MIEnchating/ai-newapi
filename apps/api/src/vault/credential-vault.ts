import { createCipheriv, createHash, randomBytes } from 'crypto';

const algorithm = 'aes-256-gcm';

export function encryptCredentialPayload(payload: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, credentialKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

function credentialKey() {
  const secret = process.env.CREDENTIAL_SECRET;

  if (!secret) {
    throw new Error('CREDENTIAL_SECRET is required before storing upstream credentials');
  }

  return createHash('sha256').update(secret).digest();
}
