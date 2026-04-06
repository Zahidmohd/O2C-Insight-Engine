import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConfigModule } from '../config/config.module';
import { AppCacheModule } from '../cache/cache.module';
import { QueryService } from './query.service';
import { QueryController } from './query.controller';
import { RateLimitGuard } from './rate-limit.guard';

@Module({
  imports: [DatabaseModule, ConfigModule, AppCacheModule],
  controllers: [QueryController],
  providers: [QueryService, RateLimitGuard],
  exports: [QueryService],
})
export class QueryModule {}
