import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { DatabaseModule } from './database/database.module';
import { ConfigModule as AppConfigModule } from './config/config.module';
import { AppCacheModule } from './cache/cache.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { TenantModule } from './tenant/tenant.module';
import { QueryModule } from './query/query.module';
import { DocumentModule } from './document/document.module';
import { OrganizationModule } from './organization/organization.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'frontend', 'dist'),
    }),
    DatabaseModule,
    AppConfigModule,
    AppCacheModule,
    QueueModule,
    AuthModule,
    TenantModule,
    QueryModule,
    DocumentModule,
    OrganizationModule,
    MetricsModule,
  ],
})
export class AppModule {}
