import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

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

export function decryptCredentialPayload(encryptedPayload: string): Record<string, string> {
  const [version, ivValue, tagValue, encryptedValue] = encryptedPayload.split(':');

  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('unsupported credential payload');
  }

  const decipher = createDecipheriv(algorithm, credentialKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final()
  ]).toString('utf8');

  const payload = JSON.parse(decrypted) as unknown;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid credential payload');
  }

  return Object.fromEntries(
    Object.entries(payload).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function credentialKey() {
  const secret = process.env.CREDENTIAL_SECRET;

  if (!secret) {
    throw new Error('CREDENTIAL_SECRET is required before storing upstream credentials');
  }

  return createHash('sha256').update(secret).digest();
}
