import { Injectable } from '@nestjs/common';
import { getTenant, registerTenant, removeTenant, listTenants, getDbForTenant, markInitialized } from '../db/tenantRegistry';

@Injectable()
export class TenantService {
  getTenant(id: string): any {
    return getTenant(id);
  }

  registerTenant(id: string, url: string, token: string, config?: any): any {
    return registerTenant(id, url, token, config);
  }

  removeTenant(id: string): any {
    return removeTenant(id);
  }

  listTenants(): any[] {
    return listTenants();
  }

  getDbForTenant(id: string): any {
    return getDbForTenant(id);
  }

  markInitialized(id: string): any {
    return markInitialized(id);
  }
}
