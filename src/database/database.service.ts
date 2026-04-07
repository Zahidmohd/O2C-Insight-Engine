import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import db from '../db/connection';
import initDB from '../db/init';
import { loadDataset } from '../db/loader';
import { embedKBEntries } from '../rag/knowledgeBase';
import { getTenant, registerTenant, removeTenant, listTenants, getDbForTenant } from '../db/tenantRegistry';
import { createTursoAdapter } from '../db/tursoAdapter';
import { getActiveConfig, defaultConfig } from '../config/activeDataset';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  /**
   * On startup, load the default dataset into the global SQLite database.
   * This replicates what `node src/db/loader.js` did in the Express startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const config = getActiveConfig() ?? defaultConfig;
      if (!config) {
        this.logger.warn('No active dataset config found — skipping default data load.');
        return;
      }
      const database = this.getDefaultDb();
      await initDB(config, database);
      const totalRows = await loadDataset(config, database);
      this.logger.log(`Default dataset loaded: ${totalRows} rows.`);

      // Embed KB entries as vector chunks for semantic search
      try {
        const kbCount = await embedKBEntries(config, database);
        if (kbCount > 0) this.logger.log(`KB entries embedded: ${kbCount} vector chunks.`);
      } catch (err: any) {
        this.logger.warn(`KB embedding skipped: ${err.message}`);
      }
    } catch (err: any) {
      this.logger.warn(`Default data load skipped or failed: ${err.message}`);
    }
  }
  getDefaultDb(): any {
    return db;
  }

  initDB(config: any, database: any): any {
    return initDB(config, database);
  }

  loadDataset(config: any, database: any): any {
    return loadDataset(config, database);
  }

  getTenant(id: string): any {
    return getTenant(id);
  }

  registerTenant(id: string, url: string, token: string, config: any): any {
    return registerTenant(id, url, token, config);
  }

  removeTenant(id: string): any {
    return removeTenant(id);
  }

  listTenants(): any {
    return listTenants();
  }

  getDbForTenant(id: string): any {
    return getDbForTenant(id);
  }

  createTursoAdapter(url: string, token: string): any {
    return createTursoAdapter(url, token);
  }

  onModuleDestroy(): void {
    try {
      const database = this.getDefaultDb();
      if (database && typeof database.close === 'function') {
        database.close();
      }
    } catch {
      // Silently ignore if db is already closed or unavailable
    }
  }
}
