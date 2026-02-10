'use strict';

// ─────────────────────────────────────────────────────────────
//  Tests for crypto-module.js
//  Run with:  node crypto-module.test.js
// ─────────────────────────────────────────────────────────────

const assert = require('assert');
const crypto = require('crypto');
const {
    encrypt,
    decrypt,
    encryptWithPassword,
    decryptWithPassword,
    deriveKey,
    SessionKeyManager,
    KEY_LENGTH,
    SALT_LENGTH,
} = require('./crypto-module');

let passed = 0;

function test(name, fn) {
    return fn()
        .then(() => { passed++; console.log(`  ✔  ${name}`); })
        .catch((err) => { console.error(`  ✖  ${name}\n     ${err.message}`); process.exitCode = 1; });
}

(async () => {
    console.log('\n🔐  crypto-module tests\n');

    // ── Session Key Manager ──────────────────────────────────

    await test('SessionKeyManager generates a 32-byte key', async () => {
        const mgr = new SessionKeyManager();
        assert.strictEqual(mgr.key.length, KEY_LENGTH);
        mgr.destroy();
    });

    await test('SessionKeyManager.destroy zeroes out the key', async () => {
        const mgr = new SessionKeyManager();
        mgr.destroy();
        assert.throws(() => mgr.key, /destroyed/i);
    });

    // ── PBKDF2 Key Derivation ───────────────────────────────

    await test('deriveKey returns key, salt, iterations', async () => {
        const result = await deriveKey('my-secret-password');
        assert.strictEqual(result.key.length, KEY_LENGTH);
        assert.strictEqual(result.salt.length, SALT_LENGTH);
        assert.strictEqual(typeof result.iterations, 'number');
    });

    await test('deriveKey with same password + salt → same key', async () => {
        const salt = crypto.randomBytes(SALT_LENGTH);
        const a = await deriveKey('hello', salt);
        const b = await deriveKey('hello', salt);
        assert.ok(a.key.equals(b.key));
    });

    await test('deriveKey with different salts → different keys', async () => {
        const a = await deriveKey('hello');
        const b = await deriveKey('hello');
        assert.ok(!a.key.equals(b.key)); // random salts
    });

    await test('deriveKey rejects empty password', async () => {
        await assert.rejects(() => deriveKey(''), TypeError);
    });

    // ── AES-256-GCM Encrypt / Decrypt ───────────────────────

    await test('encrypt → decrypt roundtrip (string)', async () => {
        const key = crypto.randomBytes(KEY_LENGTH);
        const { encrypted } = encrypt('Hola mundo 🔑', key);
        const plaintext = decrypt(encrypted, key).toString('utf8');
        assert.strictEqual(plaintext, 'Hola mundo 🔑');
    });

    await test('encrypt → decrypt roundtrip (Buffer)', async () => {
        const key = crypto.randomBytes(KEY_LENGTH);
        const original = Buffer.from([0x00, 0xff, 0x42, 0x13]);
        const { encrypted } = encrypt(original, key);
        const result = decrypt(encrypted, key);
        assert.ok(original.equals(result));
    });

    await test('decrypt with wrong key throws', async () => {
        const key1 = crypto.randomBytes(KEY_LENGTH);
        const key2 = crypto.randomBytes(KEY_LENGTH);
        const { encrypted } = encrypt('secret', key1);
        assert.throws(() => decrypt(encrypted, key2));
    });

    await test('tampered ciphertext fails authentication', async () => {
        const key = crypto.randomBytes(KEY_LENGTH);
        const { encrypted } = encrypt('secret data', key);
        // Flip a byte in the ciphertext region
        encrypted[encrypted.length - 1] ^= 0xff;
        assert.throws(() => decrypt(encrypted, key));
    });

    await test('AAD mismatch fails authentication', async () => {
        const key = crypto.randomBytes(KEY_LENGTH);
        const { encrypted } = encrypt('data', key, 'context-A');
        assert.throws(() => decrypt(encrypted, key, 'context-B'));
    });

    await test('encrypt with AAD → decrypt with same AAD works', async () => {
        const key = crypto.randomBytes(KEY_LENGTH);
        const aad = 'user:42';
        const { encrypted } = encrypt('private', key, aad);
        const result = decrypt(encrypted, key, aad).toString('utf8');
        assert.strictEqual(result, 'private');
    });

    // ── Password-based convenience ──────────────────────────

    await test('encryptWithPassword → decryptWithPassword roundtrip', async () => {
        const payload = await encryptWithPassword('Mensaje secreto 🚀', 'clave-segura');
        const result = await decryptWithPassword(payload, 'clave-segura');
        assert.strictEqual(result, 'Mensaje secreto 🚀');
    });

    await test('decryptWithPassword with wrong password throws', async () => {
        const payload = await encryptWithPassword('secret', 'correct');
        await assert.rejects(() => decryptWithPassword(payload, 'wrong'));
    });

    // ── Session key encrypt / decrypt ───────────────────────

    await test('Full session flow: create key → encrypt → decrypt → destroy', async () => {
        const session = new SessionKeyManager();

        const { encrypted } = encrypt('datos de sesión', session.key);
        const plaintext = decrypt(encrypted, session.key).toString('utf8');
        assert.strictEqual(plaintext, 'datos de sesión');

        session.destroy();
        assert.throws(() => session.key);
    });

    // ── Summary ─────────────────────────────────────────────

    console.log(`\n  ${passed} tests passed ✅\n`);
})();
