/**
 * Authentication routes — register, login, me.
 * Uses shared Turso auth DB for user credentials.
 * On registration, auto-provisions a per-tenant Turso data DB.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { authGet, authRun } = require('./authDb');
const { getTenant, registerTenant, getDbForTenant, markInitialized } = require('../db/tenantRegistry');
const { getActiveConfig, setTenantConfig } = require('../config/activeDataset');
const initDB = require('../db/init');
const { loadDataset } = require('../db/loader');
const { initDocumentTables } = require('../rag/vectorStore');

const JWT_SECRET = process.env.JWT_SECRET || 'o2c-insight-engine-secret-' + Date.now();
const TURSO_API_TOKEN = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG = process.env.TURSO_ORG_SLUG;

// ─── Register ────────────────────────────────────────────────────────────────

router.post('/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: { message: 'Email and password are required.', type: 'VALIDATION_ERROR' } });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: { message: 'Password must be at least 6 characters.', type: 'VALIDATION_ERROR' } });
        }

        // Check if email already exists
        const existing = await authGet('SELECT id, tenant_id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
        if (existing) {
            return res.status(409).json({ success: false, error: { message: 'Email already registered. Please sign in.', type: 'CONFLICT' } });
        }

        // Generate tenant ID and hash password
        const tenantId = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 10);

        // Create user in auth DB
        await authRun(
            'INSERT INTO users (email, password_hash, tenant_id) VALUES (?, ?, ?)',
            [email.toLowerCase().trim(), passwordHash, tenantId]
        );

        console.log(`[AUTH] User registered: ${email} → tenant ${tenantId}`);

        // Provision Turso DB for tenant (background, non-blocking)
        provisionTenantDb(tenantId);

        // Generate JWT
        const token = jwt.sign({ email: email.toLowerCase().trim(), tenantId }, JWT_SECRET, { expiresIn: '30d' });

        return res.status(201).json({
            success: true,
            token,
            tenantId,
            message: 'Account created. Your database is initializing in the background.'
        });

    } catch (err) {
        console.error('[AUTH] Register error:', err.message);
        return res.status(500).json({ success: false, error: { message: `Registration failed: ${err.message}`, type: 'API_ERROR' } });
    }
});

// ─── Login ───────────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: { message: 'Email and password are required.', type: 'VALIDATION_ERROR' } });
        }

        const user = await authGet('SELECT id, email, password_hash, tenant_id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
        if (!user) {
            console.warn(`[AUTH] Login failed — email not found: ${email}`);
            return res.status(401).json({ success: false, error: { message: 'Invalid email or password.', type: 'AUTH_ERROR' } });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            console.warn(`[AUTH] Login failed — wrong password for: ${email}`);
            return res.status(401).json({ success: false, error: { message: 'Invalid email or password.', type: 'AUTH_ERROR' } });
        }

        // Ensure tenant is registered in memory (may have been lost after redeploy)
        if (!getTenant(user.tenant_id)) {
            provisionTenantDb(user.tenant_id);
        }

        const token = jwt.sign({ email: user.email, tenantId: user.tenant_id }, JWT_SECRET, { expiresIn: '30d' });

        console.log(`[AUTH] User logged in: ${email}`);

        return res.status(200).json({
            success: true,
            token,
            tenantId: user.tenant_id
        });

    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        return res.status(500).json({ success: false, error: { message: `Login failed: ${err.message}`, type: 'API_ERROR' } });
    }
});

// ─── Me (verify token + get user info) ───────────────────────────────────────

router.get('/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: { message: 'Not authenticated.', type: 'AUTH_ERROR' } });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        return res.status(200).json({
            success: true,
            email: decoded.email,
            tenantId: decoded.tenantId
        });
    } catch {
        return res.status(401).json({ success: false, error: { message: 'Invalid or expired token.', type: 'AUTH_ERROR' } });
    }
});

// ─── Background Tenant Provisioning ──────────────────────────────────────────

async function provisionTenantDb(tenantId) {
    try {
        // Skip if already registered
        if (getTenant(tenantId)) return;

        if (!TURSO_API_TOKEN || !TURSO_ORG_SLUG) {
            console.log(`[AUTH] No Turso credentials — tenant ${tenantId} will use global SQLite.`);
            return;
        }

        const safeTenantId = tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        // Create or reuse Turso DB
        let hostname;
        const createRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `o2c-${safeTenantId}`, group: 'default' })
        });

        if (createRes.ok) {
            const data = await createRes.json();
            hostname = data.database.Hostname;
        } else {
            const infoRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}`, {
                headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
            });
            if (infoRes.ok) {
                hostname = (await infoRes.json()).database.Hostname;
            } else {
                hostname = `o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
            }
        }

        // Generate token
        const tokenRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}/auth/tokens`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
        });

        if (!tokenRes.ok) throw new Error('Token generation failed');
        const finalToken = (await tokenRes.json()).jwt;
        const finalUrl = `libsql://${hostname}`;

        registerTenant(safeTenantId, finalUrl, finalToken);

        // Check if DB already has tables
        const tenantDb = getDbForTenant(safeTenantId);
        const existingTables = await tenantDb.allAsync(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks', '_litestream_seq', '_litestream_lock')"
        );

        if (existingTables.length > 0) {
            console.log(`[AUTH] Turso DB already has ${existingTables.length} tables for tenant ${safeTenantId}, skipping init.`);
            setTenantConfig(safeTenantId, getActiveConfig());
            markInitialized(safeTenantId);
        } else {
            console.log(`[AUTH] Initializing Turso DB for tenant ${safeTenantId}...`);
            const defaultConfig = getActiveConfig();
            await initDocumentTables(tenantDb);
            await initDB(defaultConfig, tenantDb);
            await loadDataset(defaultConfig, tenantDb);
            setTenantConfig(safeTenantId, defaultConfig);
            markInitialized(safeTenantId);
            console.log(`[AUTH] Tenant ${safeTenantId} fully initialized.`);
        }

    } catch (err) {
        console.error(`[AUTH] Tenant provisioning failed for ${tenantId}:`, err.message);
    }
}

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.provisionTenantDb = provisionTenantDb;
