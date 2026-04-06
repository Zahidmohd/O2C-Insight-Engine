import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

interface JwtPayload {
  email: string;
  tenantId: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        process.env.JWT_SECRET || 'o2c-insight-engine-secret-default',
    });
  }

  /**
   * Called after JWT is verified. Return value becomes req.user.
   */
  async validate(payload: JwtPayload): Promise<{ email: string; tenantId: string }> {
    return { email: payload.email, tenantId: payload.tenantId };
  }
}
