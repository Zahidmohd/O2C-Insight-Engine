import { Request } from 'express';

export interface AppRequest extends Request {
  db?: any;
  tenantId?: string;
  config?: any;
  user?: { email: string; tenantId: string };
}
