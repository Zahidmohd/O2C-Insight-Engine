import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  async register(
    @Body() body: { email: string; password: string },
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { token, tenantId } = await this.authService.register(
        body.email,
        body.password,
      );

      res.status(HttpStatus.CREATED).json({
        success: true,
        token,
        tenantId,
        message: 'Account created. Your database is initializing in the background.',
      });
    } catch (err: any) {
      const status = err.status || HttpStatus.INTERNAL_SERVER_ERROR;
      const message = err.message || `Registration failed: ${String(err)}`;
      const type = err.type || 'API_ERROR';

      res.status(status).json({
        success: false,
        error: { message, type },
      });
    }
  }

  @Public()
  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { token, tenantId } = await this.authService.login(
        body.email,
        body.password,
      );

      res.status(HttpStatus.OK).json({
        success: true,
        token,
        tenantId,
      });
    } catch (err: any) {
      const status = err.status || HttpStatus.INTERNAL_SERVER_ERROR;
      const message = err.message || `Login failed: ${String(err)}`;
      const type = err.type || 'API_ERROR';

      res.status(status).json({
        success: false,
        error: { message, type },
      });
    }
  }

  @Public()
  @Get('me')
  async me(@Req() req: Request, @Res() res: Response): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        success: false,
        error: { message: 'Not authenticated.', type: 'AUTH_ERROR' },
      });
      return;
    }

    try {
      const jwt = require('jsonwebtoken');
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, this.authService.getJwtSecret());

      res.status(HttpStatus.OK).json({
        success: true,
        email: decoded.email,
        tenantId: decoded.tenantId,
      });
    } catch {
      res.status(HttpStatus.UNAUTHORIZED).json({
        success: false,
        error: { message: 'Invalid or expired token.', type: 'AUTH_ERROR' },
      });
    }
  }
}
