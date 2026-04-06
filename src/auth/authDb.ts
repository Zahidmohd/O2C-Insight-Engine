/**
 * Shared Turso auth database — stores user credentials across all tenants.
 * Separate from per-tenant data DBs.
 *
 * On first run, creates the auth DB via Turso Platform API (if configured).
 * Falls back to global SQLite for dev/tests.
 */

import { createClient, Client } from '@libsql/client';
import db from '../db/connection';

const TURSO_API_TOKEN: string | undefined = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG: string | undefined = process.env.TURSO_ORG_SLUG;
const AUTH_DB_NAME: string = 'o2c-auth';

let authClient: Client | null = null;

/**
 * Initializes the auth database.
 * - Turso: creates/reuses a shared auth DB, creates users table
 * - SQLite fallback: creates users table in global SQLite
 */
async function initAuthDb(): Promise<void> {
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

            let hostname: string;
            if (createRes.ok) {
                const data: any = await createRes.json();
                hostname = data.database.Hostname;
                console.log('[AUTH] Created new Turso auth DB.');
            } else {
                // DB exists — look up hostname
                const infoRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/${AUTH_DB_NAME}`, {
                    headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
                });
                if (infoRes.ok) {
                    const data: any = await infoRes.json();
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

            const tokenData: any = await tokenRes.json();
            authClient = createClient({
                url: `libsql://${hostname}`,
                authToken: tokenData.jwt
            });

            console.log(`[AUTH] Connected to Turso auth DB: ${hostname}`);
        } catch (err: any) {
            console.warn(`[AUTH] Turso auth DB failed, using SQLite fallback: ${err.message}`);
            authClient = null;
        }
    }

    // Create users + organizations tables
    const createSql: string = `
        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            invite_code TEXT UNIQUE NOT NULL,
            tenant_id TEXT UNIQUE NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            tenant_id TEXT UNIQUE NOT NULL,
            personal_tenant_id TEXT NOT NULL,
            organization_id TEXT,
            active_workspace TEXT DEFAULT 'personal',
            role TEXT DEFAULT 'member',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
    `;

    if (authClient) {
        await authClient.executeMultiple(createSql);
    } else {
        await (db as any).execAsync(createSql);
    }

    console.log('[AUTH] Users + Organizations tables initialized.');
}

/**
 * Execute a query on the auth database.
 */
async function authQuery(sql: string, params: any[] = []): Promise<any[]> {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return result.rows as any[];
    }
    return await (db as any).allAsync(sql, params);
}

async function authRun(sql: string, params: any[] = []): Promise<{ lastInsertRowid: any; changes: any }> {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return { lastInsertRowid: result.lastInsertRowid, changes: result.rowsAffected };
    }
    return await (db as any).runAsync(sql, params);
}

async function authGet(sql: string, params: any[] = []): Promise<any | null> {
    if (authClient) {
        const result = await authClient.execute({ sql, args: params });
        return result.rows[0] || null;
    }
    return await (db as any).getAsync(sql, params);
}

export { initAuthDb, authQuery, authRun, authGet };
