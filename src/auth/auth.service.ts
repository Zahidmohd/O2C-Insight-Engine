import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { initAuthDb, authGet, authRun } from './authDb';
import { JWT_SECRET, provisionTenantDb as provisionTenantDbFn } from './tenantProvisioner';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  async onModuleInit(): Promise<void> {
    await this.initAuthDb();
  }

  /**
   * Initialize the auth database (creates users table).
   */
  async initAuthDb(): Promise<void> {
    await initAuthDb();
    this.logger.log('Auth database initialized.');
  }

  /**
   * Returns the JWT secret used for signing tokens.
   */
  getJwtSecret(): string {
    return JWT_SECRET;
  }

  /**
   * Register a new user. Returns { token, tenantId }.
   */
  async register(
    email: string,
    password: string,
  ): Promise<{ token: string; tenantId: string }> {
    if (!email || !password) {
      throw { status: 400, message: 'Email and password are required.', type: 'VALIDATION_ERROR' };
    }

    if (password.length < 6) {
      throw { status: 400, message: 'Password must be at least 6 characters.', type: 'VALIDATION_ERROR' };
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await authGet(
      'SELECT id, tenant_id FROM users WHERE email = ?',
      [normalizedEmail],
    );
    if (existing) {
      throw { status: 409, message: 'Email already registered. Please sign in.', type: 'CONFLICT' };
    }

    // Generate tenant ID and hash password
    const tenantId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user in auth DB — personal_tenant_id is always preserved
    await authRun(
      'INSERT INTO users (email, password_hash, tenant_id, personal_tenant_id) VALUES (?, ?, ?, ?)',
      [normalizedEmail, passwordHash, tenantId, tenantId],
    );

    this.logger.log(`User registered: ${normalizedEmail} → tenant ${tenantId}`);

    // Provision Turso DB for tenant (background, non-blocking)
    this.provisionTenantDb(tenantId);

    // Generate JWT
    const token = jwt.sign(
      { email: normalizedEmail, tenantId },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    return { token, tenantId };
  }

  /**
   * Authenticate a user. Returns { token, tenantId }.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; tenantId: string }> {
    if (!email || !password) {
      throw { status: 400, message: 'Email and password are required.', type: 'VALIDATION_ERROR' };
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await authGet(
      'SELECT id, email, password_hash, tenant_id FROM users WHERE email = ?',
      [normalizedEmail],
    );
    if (!user) {
      this.logger.warn(`Login failed — email not found: ${normalizedEmail}`);
      throw { status: 401, message: 'Invalid email or password.', type: 'AUTH_ERROR' };
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      this.logger.warn(`Login failed — wrong password for: ${normalizedEmail}`);
      throw { status: 401, message: 'Invalid email or password.', type: 'AUTH_ERROR' };
    }

    // Ensure tenant is provisioned (may have been lost after redeploy)
    this.provisionTenantDb(user.tenant_id);

    const token = jwt.sign(
      { email: user.email, tenantId: user.tenant_id },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    this.logger.log(`User logged in: ${normalizedEmail}`);

    return { token, tenantId: user.tenant_id };
  }

  /**
   * Get user info from a JWT token (for /me endpoint).
   */
  getMe(email: string): { email: string } {
    return { email };
  }

  /**
   * Provision a per-tenant database (delegates to existing JS function).
   */
  provisionTenantDb(tenantId: string): void {
    provisionTenantDbFn(tenantId).catch((err: Error) => {
      this.logger.error(
        `Tenant provisioning failed for ${tenantId}: ${err.message}`,
      );
    });
  }
}
