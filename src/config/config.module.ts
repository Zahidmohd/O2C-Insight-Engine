import { Module, Global } from '@nestjs/common';
import { DatasetConfigService } from './dataset-config.service';

@Global()
@Module({
  providers: [DatasetConfigService],
  exports: [DatasetConfigService],
})
export class ConfigModule {}
