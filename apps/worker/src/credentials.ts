import { createDecipheriv, createHash } from 'crypto';

const algorithm = 'aes-256-gcm';

export function decryptCredentialPayload(payload?: string): Record<string, string> {
  if (!payload) {
    return {};
  }

  if (payload.trim().startsWith('{')) {
    return JSON.parse(payload) as Record<string, string>;
  }

  const [version, iv, tag, encrypted] = payload.split(':');

  if (version !== 'v1' || !iv || !tag || !encrypted) {
    throw new Error('unsupported credential payload format');
  }

  const decipher = createDecipheriv(algorithm, credentialKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>;
}

function credentialKey() {
  const secret = process.env.CREDENTIAL_SECRET;

  if (!secret) {
    throw new Error('CREDENTIAL_SECRET is required before reading upstream credentials');
  }

  return createHash('sha256').update(secret).digest();
}
