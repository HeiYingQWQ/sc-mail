import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const algorithm = 'aes-256-gcm';

export function parseCredentialKey(value: string): Buffer {
  const key = /^[a-fA-F0-9]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('Invalid credential encryption key');
  return key;
}

export function encryptCredential(plaintext: string, keyValue: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, parseCredentialKey(keyValue), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptCredential(value: string, keyValue: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) {
    throw new Error('Invalid encrypted credential format');
  }
  const decipher = createDecipheriv(algorithm, parseCredentialKey(keyValue), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
