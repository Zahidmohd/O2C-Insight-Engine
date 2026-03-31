/**
 * JWT authentication middleware.
 * Extracts tenantId from the JWT token and attaches to req.
 *
 * Exempt routes (health, providers, auth) skip authentication.
 * Authenticated routes get req.user = { email, tenantId }.
 */

const jwt = require('jsonwebtoken');

const EXEMPT_PATHS = ['/api/health', '/api/providers', '/api/auth', '/api/tenants'];

function authMiddleware(jwtSecret) {
    return (req, res, next) => {
        // Exempt infra and auth routes
        const isExempt = EXEMPT_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'));
        if (isExempt) {
            return next();
        }

        const authHeader = req.headers.authorization;

        // No auth header — check for legacy X-Tenant-Id or allow unauthenticated (backward compat for tests)
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            const legacyTenantId = req.headers['x-tenant-id'];
            req.user = null;
            req.tenantId = legacyTenantId || null;
            return next();
        }

        // Verify JWT
        try {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, jwtSecret);
            req.user = { email: decoded.email, tenantId: decoded.tenantId };
            req.tenantId = decoded.tenantId;
            next();
        } catch {
            return res.status(401).json({
                success: false,
                error: { message: 'Invalid or expired token. Please login again.', type: 'AUTH_ERROR' }
            });
        }
    };
}

module.exports = authMiddleware;
