import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, encrypt, decrypt, generateEncryptionKey } from '../utils/crypto.js';

describe('Crypto Utils', () => {
  describe('hashPassword / verifyPassword', () => {
    it('should hash a password and verify it correctly', () => {
      const password = 'mySecurePassword123!';
      const hash = hashPassword(password);
      expect(hash).toBeTruthy();
      expect(hash).toContain(':');
      expect(verifyPassword(password, hash)).toBe(true);
    });

    it('should reject wrong password', () => {
      const hash = hashPassword('correctPassword');
      expect(verifyPassword('wrongPassword', hash)).toBe(false);
    });

    it('should produce unique hashes for same password', () => {
      const hash1 = hashPassword('samePassword');
      const hash2 = hashPassword('samePassword');
      expect(hash1).not.toBe(hash2);
      expect(verifyPassword('samePassword', hash1)).toBe(true);
      expect(verifyPassword('samePassword', hash2)).toBe(true);
    });

    it('should handle empty password', () => {
      const hash = hashPassword('');
      expect(verifyPassword('', hash)).toBe(true);
      expect(verifyPassword('notEmpty', hash)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('should encrypt and decrypt text correctly', () => {
      const key = generateEncryptionKey();
      const plaintext = 'Hello, World! This is a secret message.';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext each time', () => {
      const key = generateEncryptionKey();
      const plaintext = 'same text';
      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle unicode text', () => {
      const key = generateEncryptionKey();
      const plaintext = 'Hello 你好 🎉 مرحبا';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle long text', () => {
      const key = generateEncryptionKey();
      const plaintext = 'A'.repeat(10000);
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should fail with wrong key', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const encrypted = encrypt('secret', key1);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('should work with arbitrary string keys', () => {
      const key = 'my-custom-key-string';
      const plaintext = 'test data';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('generateEncryptionKey', () => {
    it('should generate a 64-char hex string', () => {
      const key = generateEncryptionKey();
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });
  });
});
