import { Controller, Post, Get, Delete, Body, Req, HttpException } from '@nestjs/common';
import { OrganizationService } from './organization.service';

@Controller('organizations')
export class OrganizationController {
    constructor(private readonly orgService: OrganizationService) {}

    /**
     * POST /api/organizations — Create a new organization (team mode).
     * The creator becomes admin. Returns invite code for team members.
     */
    @Post()
    async create(@Body() body: { name: string }, @Req() req: any) {
        try {
            const email = req.user?.email;
            if (!email) throw { status: 401, message: 'Authentication required.', type: 'AUTH_ERROR' };

            const result = await this.orgService.createOrganization(body.name, email);
            return {
                success: true,
                message: `Organization "${body.name}" created. Share the invite code with your team.`,
                ...result,
            };
        } catch (err: any) {
            throw new HttpException(
                { success: false, error: { message: err.message, type: err.type || 'API_ERROR' } },
                err.status || 500,
            );
        }
    }

    /**
     * POST /api/organizations/join — Join an organization with invite code.
     * User's data switches to the shared org database (team cache benefits).
     */
    @Post('join')
    async join(@Body() body: { inviteCode: string }, @Req() req: any) {
        try {
            const email = req.user?.email;
            if (!email) throw { status: 401, message: 'Authentication required.', type: 'AUTH_ERROR' };

            const result = await this.orgService.joinOrganization(body.inviteCode, email);
            return {
                success: true,
                message: `You joined "${result.orgName}". You now share data and cache with your team.`,
                ...result,
            };
        } catch (err: any) {
            throw new HttpException(
                { success: false, error: { message: err.message, type: err.type || 'API_ERROR' } },
                err.status || 500,
            );
        }
    }

    /**
     * POST /api/organizations/leave — Leave your organization (switch to personal mode).
     */
    @Post('leave')
    async leave(@Req() req: any) {
        try {
            const email = req.user?.email;
            if (!email) throw { status: 401, message: 'Authentication required.', type: 'AUTH_ERROR' };

            await this.orgService.leaveOrganization(email);
            return {
                success: true,
                message: 'You left the organization. A personal workspace is being set up.',
            };
        } catch (err: any) {
            throw new HttpException(
                { success: false, error: { message: err.message, type: err.type || 'API_ERROR' } },
                err.status || 500,
            );
        }
    }

    /**
     * POST /api/organizations/switch — Switch between personal and team workspace.
     * Like Notion/Slack — toggle without leaving the org.
     */
    @Post('switch')
    async switchWorkspace(@Body() body: { mode: 'personal' | 'team' }, @Req() req: any) {
        try {
            const email = req.user?.email;
            if (!email) throw { status: 401, message: 'Authentication required.', type: 'AUTH_ERROR' };

            if (!body.mode || !['personal', 'team'].includes(body.mode)) {
                throw { status: 400, message: 'Mode must be "personal" or "team".', type: 'VALIDATION_ERROR' };
            }

            const result = await this.orgService.switchWorkspace(email, body.mode);
            return {
                success: true,
                message: `Switched to ${result.mode} workspace.`,
                ...result,
            };
        } catch (err: any) {
            throw new HttpException(
                { success: false, error: { message: err.message, type: err.type || 'API_ERROR' } },
                err.status || 500,
            );
        }
    }

    /**
     * GET /api/organizations/me — Get current user's organization details + members.
     */
    @Get('me')
    async getMyOrg(@Req() req: any) {
        try {
            const email = req.user?.email;
            if (!email) throw { status: 401, message: 'Authentication required.', type: 'AUTH_ERROR' };

            const org = await this.orgService.getUserOrganization(email);
            return {
                success: true,
                mode: org ? 'team' : 'individual',
                organization: org,
            };
        } catch (err: any) {
            throw new HttpException(
                { success: false, error: { message: err.message, type: err.type || 'API_ERROR' } },
                err.status || 500,
            );
        }
    }
}
