import { Injectable, Logger } from '@nestjs/common';
import { authGet, authRun, authQuery } from '../auth/authDb';
import { provisionTenantDb } from '../auth/tenantProvisioner';
import * as crypto from 'crypto';

@Injectable()
export class OrganizationService {
    private readonly logger = new Logger(OrganizationService.name);

    /**
     * Create a new organization. The creator becomes the admin.
     * A shared tenant DB is provisioned for the entire org.
     */
    async createOrganization(name: string, creatorEmail: string): Promise<{
        orgId: string;
        inviteCode: string;
        tenantId: string;
    }> {
        if (!name || name.trim().length < 2) {
            throw { status: 400, message: 'Organization name must be at least 2 characters.', type: 'VALIDATION_ERROR' };
        }

        // Get creator's user record
        const creator = await authGet('SELECT id, email, tenant_id FROM users WHERE email = ?', [creatorEmail]);
        if (!creator) {
            throw { status: 404, message: 'User not found.', type: 'NOT_FOUND' };
        }

        const orgId = crypto.randomUUID();
        const inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char code like "A3F2B1C9"
        const tenantId = creator.tenant_id; // Reuse creator's tenant as the org tenant

        // Create the organization
        await authRun(
            'INSERT INTO organizations (id, name, invite_code, tenant_id, created_by) VALUES (?, ?, ?, ?, ?)',
            [orgId, name.trim(), inviteCode, tenantId, creatorEmail]
        );

        // Update creator as org admin
        await authRun(
            'UPDATE users SET organization_id = ?, role = ? WHERE email = ?',
            [orgId, 'admin', creatorEmail]
        );

        this.logger.log(`Organization "${name}" created by ${creatorEmail} (code: ${inviteCode})`);

        return { orgId, inviteCode, tenantId };
    }

    /**
     * Join an existing organization via invite code.
     * The user's tenant_id is updated to the org's shared tenant.
     */
    async joinOrganization(inviteCode: string, userEmail: string): Promise<{
        orgId: string;
        orgName: string;
        tenantId: string;
    }> {
        if (!inviteCode) {
            throw { status: 400, message: 'Invite code is required.', type: 'VALIDATION_ERROR' };
        }

        // Find the organization
        const org = await authGet(
            'SELECT id, name, tenant_id FROM organizations WHERE invite_code = ?',
            [inviteCode.toUpperCase().trim()]
        );
        if (!org) {
            throw { status: 404, message: 'Invalid invite code. No organization found.', type: 'NOT_FOUND' };
        }

        // Check user exists
        const user = await authGet('SELECT id, email, organization_id FROM users WHERE email = ?', [userEmail]);
        if (!user) {
            throw { status: 404, message: 'User not found.', type: 'NOT_FOUND' };
        }

        if (user.organization_id) {
            throw { status: 409, message: 'You are already part of an organization. Leave first to join another.', type: 'CONFLICT' };
        }

        // Update user to join org — switch active workspace to team, keep personal tenant
        await authRun(
            'UPDATE users SET organization_id = ?, tenant_id = ?, active_workspace = ?, role = ? WHERE email = ?',
            [org.id, org.tenant_id, 'team', 'member', userEmail]
        );

        this.logger.log(`${userEmail} joined organization "${org.name}"`);

        return { orgId: org.id, orgName: org.name, tenantId: org.tenant_id };
    }

    /**
     * Leave an organization. User gets a fresh personal tenant.
     */
    async leaveOrganization(userEmail: string): Promise<void> {
        const user = await authGet(
            'SELECT id, email, organization_id, personal_tenant_id FROM users WHERE email = ?',
            [userEmail]
        );
        if (!user || !user.organization_id) {
            throw { status: 400, message: 'You are not part of any organization.', type: 'VALIDATION_ERROR' };
        }

        // Restore personal tenant — no new provisioning needed, it already exists
        await authRun(
            'UPDATE users SET organization_id = NULL, tenant_id = ?, active_workspace = ?, role = ? WHERE email = ?',
            [user.personal_tenant_id, 'personal', 'member', userEmail]
        );

        this.logger.log(`${userEmail} left their organization. Restored personal workspace.`);
    }

    /**
     * Get organization details + members.
     */
    async getOrganization(orgId: string): Promise<any> {
        const org = await authGet('SELECT * FROM organizations WHERE id = ?', [orgId]);
        if (!org) {
            throw { status: 404, message: 'Organization not found.', type: 'NOT_FOUND' };
        }

        const members = await authQuery(
            'SELECT email, role, created_at FROM users WHERE organization_id = ? ORDER BY created_at',
            [orgId]
        );

        return {
            id: org.id,
            name: org.name,
            inviteCode: org.invite_code,
            tenantId: org.tenant_id,
            createdBy: org.created_by,
            createdAt: org.created_at,
            members: members.map((m: any) => ({
                email: m.email,
                role: m.role,
                joinedAt: m.created_at,
            })),
            memberCount: members.length,
        };
    }

    /**
     * Switch between personal and team workspace.
     * Like Notion/Slack — user always has both, just toggles which is active.
     */
    async switchWorkspace(userEmail: string, mode: 'personal' | 'team'): Promise<{
        mode: string;
        tenantId: string;
    }> {
        const user = await authGet(
            'SELECT id, email, organization_id, personal_tenant_id, active_workspace FROM users WHERE email = ?',
            [userEmail]
        );
        if (!user) {
            throw { status: 404, message: 'User not found.', type: 'NOT_FOUND' };
        }

        if (mode === 'team') {
            if (!user.organization_id) {
                throw { status: 400, message: 'You are not part of any organization. Create or join one first.', type: 'VALIDATION_ERROR' };
            }
            const org = await authGet('SELECT tenant_id FROM organizations WHERE id = ?', [user.organization_id]);
            if (!org) {
                throw { status: 404, message: 'Organization not found.', type: 'NOT_FOUND' };
            }
            await authRun(
                'UPDATE users SET tenant_id = ?, active_workspace = ? WHERE email = ?',
                [org.tenant_id, 'team', userEmail]
            );
            this.logger.log(`${userEmail} switched to team workspace`);
            return { mode: 'team', tenantId: org.tenant_id };
        } else {
            await authRun(
                'UPDATE users SET tenant_id = ?, active_workspace = ? WHERE email = ?',
                [user.personal_tenant_id, 'personal', userEmail]
            );
            this.logger.log(`${userEmail} switched to personal workspace`);
            return { mode: 'personal', tenantId: user.personal_tenant_id };
        }
    }

    /**
     * Get the organization for a user (if any).
     */
    async getUserOrganization(userEmail: string): Promise<any | null> {
        const user = await authGet('SELECT organization_id FROM users WHERE email = ?', [userEmail]);
        if (!user || !user.organization_id) return null;
        return this.getOrganization(user.organization_id);
    }
}
