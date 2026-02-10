// ─────────────────────────────────────────────────────────────
//  crypto-browser.js
//  Browser-compatible AES-256-GCM + PBKDF2 using Web Crypto API
//  Mirrors the interface of crypto-module.js (Node.js version)
// ─────────────────────────────────────────────────────────────

const CryptoBrowser = (() => {
    'use strict';

    const IV_LENGTH = 12;
    const AUTH_TAG_LENGTH = 16;
    const SALT_LENGTH = 32;
    const KEY_LENGTH = 32;
    const PBKDF2_ITERATIONS = 100_000; // browser-friendly; still strong

    // ── Helpers ──────────────────────────────────────────────

    function getRandomBytes(len) {
        return crypto.getRandomValues(new Uint8Array(len));
    }

    function concatBuffers(...buffers) {
        const total = buffers.reduce((s, b) => s + b.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const b of buffers) {
            out.set(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer ? b : b), offset);
            offset += b.byteLength;
        }
        return out;
    }

    function toBase64(uint8) {
        let bin = '';
        for (let i = 0; i < uint8.length; i++) bin += String.fromCharCode(uint8[i]);
        return btoa(bin);
    }

    function fromBase64(str) {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // ── PBKDF2 Key Derivation ──────────────────────────────

    async function deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
        );

        const usedSalt = salt || getRandomBytes(SALT_LENGTH);

        const key = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: usedSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-512' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

        return { key, salt: usedSalt };
    }

    // ── AES-256-GCM Encrypt ────────────────────────────────

    /**
     * Encrypts plaintext with a password.
     * Output: base64( Salt[32] | IV[12] | Ciphertext+AuthTag )
     */
    async function encryptWithPassword(plaintext, password) {
        const { key, salt } = await deriveKey(password);
        const iv = getRandomBytes(IV_LENGTH);
        const enc = new TextEncoder();

        const ciphertextWithTag = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
            key,
            enc.encode(plaintext)
        );

        const packed = concatBuffers(salt, iv, new Uint8Array(ciphertextWithTag));
        return toBase64(packed);
    }

    // ── AES-256-GCM Decrypt ────────────────────────────────

    /**
     * Decrypts a base64 payload produced by encryptWithPassword.
     */
    async function decryptWithPassword(payload, password) {
        const data = fromBase64(payload);

        if (data.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
            throw new Error('Payload too short.');
        }

        const salt = data.slice(0, SALT_LENGTH);
        const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const ciphertext = data.slice(SALT_LENGTH + IV_LENGTH);

        const { key } = await deriveKey(password, salt);

        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
            key,
            ciphertext
        );

        return new TextDecoder().decode(plainBuf);
    }

    // ── Public API ─────────────────────────────────────────

    return {
        encryptWithPassword,
        decryptWithPassword,
        deriveKey,
        toBase64,
        fromBase64,
        SALT_LENGTH,
        IV_LENGTH,
        AUTH_TAG_LENGTH,
        KEY_LENGTH,
        PBKDF2_ITERATIONS,
    };
})();
