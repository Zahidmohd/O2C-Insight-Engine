/**
 * Shared Turso auth database — stores user credentials across all tenants.
 * Separate from per-tenant data DBs.
 *
 * On first run, creates the auth DB via Turso Platform API (if configured).
 * Falls back to global SQLite for dev/tests.
 */

const { createClient } = require('@libsql/client');
const db = require('../db/connection');

const TURSO_API_TOKEN = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG = process.env.TURSO_ORG_SLUG;
const AUTH_DB_NAME = 'o2c-auth';

let authClient = null;

/**
 * Initializes the auth database.
 * - Turso: creates/reuses a shared auth DB, creates users table
 * - SQLite fallback: creates users table in global SQLite
 */
async function initAuthDb() {
    if (TURSO_API_TOKEN && TURSO_ORG_SLUG) {
        try {
            // Try to create auth DB (will 409 if exists — that's fine)
            const createRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${TURSO_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: AUTH_DB_NAME, group: 'default' })
            });

            let hostname;
            if (createRes.ok) {
                const data = await createRes.json();
                hostname = data.database.Hostname;
                console.log('[AUTH] Created new Turso auth DB.');
            } else {
                // DB exists — look up hostname
                const infoRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/${AUTH_DB_NAME}`, {
                    headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
                });
                if (infoRes.ok) {
                    const data = await infoRes.json();
                    hostname = data.database.Hostname;
                } else {
                    hostname = `${AUTH_DB_NAME}-${TURSO_ORG_SLUG}.turso.io`;
                }
                console.log('[AUTH] Reusing existing Turso auth DB.');
            }

            // Generate auth token for the auth DB
            const tokenRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/${AUTH_DB_NAME}/auth/tokens`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
            });

            if (!tokenRes.ok) {
                throw new Error(`Failed to generate auth DB token: ${await tokenRes.text()}`);
            }

            const tokenData = await tokenRes.json();
            authClient = createClient({
                url: `libsql://${hostname}`,
                authToken: tokenData.jwt
            });

            console.log(`[AUTH] Connected to Turso auth DB: ${hostname}`);
        } catch (err) {
            console.warn(`[AUTH] Turso auth DB failed, using SQLite fallback: ${err.message}`);
            authClient = null;
        }
    }

    // Create users table (works for both Turso client and SQLite)
    const createSql = `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            tenant_id TEXT UNIQUE NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `;

    if (authClient) {
        await authClient.executeMultiple(createSql);
    } else {
        await db.execAsync(createSql);
    }

    console.log('[AUTH] Users table initialized.');
}

/**
 * Execute a query on the auth database.
 */
async function authQuery(sql, params = []) {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return result.rows;
    }
    return await db.allAsync(sql, params);
}

async function authRun(sql, params = []) {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return { lastInsertRowid: result.lastInsertRowid, changes: result.rowsAffected };
    }
    return await db.runAsync(sql, params);
}

async function authGet(sql, params = []) {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return result.rows[0] || null;
    }
    return await db.getAsync(sql, params);
}

module.exports = { initAuthDb, authQuery, authRun, authGet };
