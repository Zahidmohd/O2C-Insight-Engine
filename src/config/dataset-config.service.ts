import { Injectable } from '@nestjs/common';
import { getActiveConfig, setActiveConfig, defaultConfig, setTenantConfig, getTenantConfig } from './activeDataset';
import { validateDatasetConfig } from './datasetValidator';

@Injectable()
export class DatasetConfigService {
  getActiveConfig(): any {
    return getActiveConfig();
  }

  setActiveConfig(config: any): any {
    return setActiveConfig(config);
  }

  get defaultConfig(): any {
    return defaultConfig;
  }

  setTenantConfig(tenantId: string, config: any): any {
    return setTenantConfig(tenantId, config);
  }

  getTenantConfig(tenantId: string): any {
    return getTenantConfig(tenantId);
  }

  validateDatasetConfig(config: any): any {
    return validateDatasetConfig(config);
  }
}
