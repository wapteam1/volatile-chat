'use strict';

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
//  AES-256-GCM Encryption Module
//  - Session-unique keys (never persisted to database)
//  - PBKDF2 key derivation with random salt
// ─────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;          // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;    // 128-bit authentication tag
const SALT_LENGTH = 32;        // 256-bit salt for PBKDF2
const KEY_LENGTH = 32;         // 256-bit key (for AES-256)
const PBKDF2_ITERATIONS = 600_000; // OWASP recommendation 2023+
const PBKDF2_DIGEST = 'sha512';

// ─────────────────────────────────────────────────────────────
//  Session Key Manager
//  Generates an ephemeral key per session that lives ONLY in
//  memory — never written to any persistent store.
// ─────────────────────────────────────────────────────────────

class SessionKeyManager {
  #key;
  #createdAt;

  constructor() {
    this.#key = crypto.randomBytes(KEY_LENGTH);
    this.#createdAt = Date.now();
  }

  /** Returns the raw session key (Buffer). */
  get key() {
    if (!this.#key) {
      throw new Error('Session key has been destroyed.');
    }
    return this.#key;
  }

  /** Timestamp (ms) when the key was generated. */
  get createdAt() {
    return this.#createdAt;
  }

  /**
   * Securely destroys the key from memory.
   * Call this when the session ends.
   */
  destroy() {
    if (this.#key) {
      this.#key.fill(0);
      this.#key = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PBKDF2 Key Derivation
// ─────────────────────────────────────────────────────────────

/**
 * Derives an AES-256 key from a password using PBKDF2.
 *
 * @param {string}  password           – User-supplied passphrase
 * @param {Buffer}  [salt]             – Optional salt; a random one is generated if omitted
 * @param {number}  [iterations]       – Number of PBKDF2 iterations (default: 600 000)
 * @returns {Promise<{ key: Buffer, salt: Buffer, iterations: number }>}
 */
async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  if (!password || typeof password !== 'string') {
    throw new TypeError('Password must be a non-empty string.');
  }

  const usedSalt = salt ?? crypto.randomBytes(SALT_LENGTH);

  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, usedSalt, iterations, KEY_LENGTH, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ key: derivedKey, salt: usedSalt, iterations });
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  AES-256-GCM Encrypt / Decrypt
// ─────────────────────────────────────────────────────────────

/**
 * Encrypts plaintext with AES-256-GCM.
 *
 * Output format (Buffer):
 *   [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext (variable) ]
 *
 * @param {string|Buffer} plaintext  – Data to encrypt
 * @param {Buffer}        key        – 256-bit encryption key
 * @param {Buffer}        [aad]      – Optional Additional Authenticated Data
 * @returns {{ encrypted: Buffer, iv: Buffer, authTag: Buffer }}
 */
function encrypt(plaintext, key, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new TypeError(`Key must be a ${KEY_LENGTH}-byte Buffer.`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  if (aad) {
    cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8'));
  }

  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack everything into a single buffer for easy transport / storage
  const encrypted = Buffer.concat([iv, authTag, ciphertext]);

  return { encrypted, iv, authTag };
}

/**
 * Decrypts an AES-256-GCM payload.
 *
 * @param {Buffer}  encrypted  – Packed buffer: IV | AuthTag | Ciphertext
 * @param {Buffer}  key        – 256-bit decryption key
 * @param {Buffer}  [aad]      – Must match the AAD used during encryption
 * @returns {Buffer} – Decrypted plaintext
 */
function decrypt(encrypted, key, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new TypeError(`Key must be a ${KEY_LENGTH}-byte Buffer.`);
  }
  if (!Buffer.isBuffer(encrypted) || encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new TypeError('Encrypted payload is too short or not a Buffer.');
  }

  const iv        = encrypted.subarray(0, IV_LENGTH);
  const authTag   = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  if (aad) {
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8'));
  }

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─────────────────────────────────────────────────────────────
//  High-level convenience: encrypt / decrypt with password
// ─────────────────────────────────────────────────────────────

/**
 * Encrypts plaintext using a password (derives key via PBKDF2 first).
 *
 * Output format (Buffer):
 *   [ Salt (32 bytes) | IV (12 bytes) | AuthTag (16 bytes) | Ciphertext ]
 *
 * @param {string}  plaintext  – Data to encrypt
 * @param {string}  password   – User-supplied passphrase
 * @returns {Promise<Buffer>}  – Self-contained encrypted payload
 */
async function encryptWithPassword(plaintext, password) {
  const { key, salt } = await deriveKey(password);
  const { encrypted } = encrypt(plaintext, key);

  // Prepend salt so we can re-derive the key during decryption
  return Buffer.concat([salt, encrypted]);
}

/**
 * Decrypts a payload that was encrypted with `encryptWithPassword`.
 *
 * @param {Buffer}  payload   – Buffer produced by encryptWithPassword
 * @param {string}  password  – Same passphrase used for encryption
 * @returns {Promise<string>} – Decrypted plaintext (UTF-8)
 */
async function decryptWithPassword(payload, password) {
  if (!Buffer.isBuffer(payload) || payload.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new TypeError('Payload is too short or not a Buffer.');
  }

  const salt      = payload.subarray(0, SALT_LENGTH);
  const encrypted = payload.subarray(SALT_LENGTH);

  const { key } = await deriveKey(password, salt);
  return decrypt(encrypted, key).toString('utf8');
}

// ─────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Core
  encrypt,
  decrypt,

  // Password-based
  encryptWithPassword,
  decryptWithPassword,

  // Key derivation
  deriveKey,

  // Session management
  SessionKeyManager,

  // Constants (for reference / testing)
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  SALT_LENGTH,
  KEY_LENGTH,
  PBKDF2_ITERATIONS,
  PBKDF2_DIGEST,
};
