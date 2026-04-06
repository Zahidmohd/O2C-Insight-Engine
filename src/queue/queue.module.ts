import { Module, Global } from '@nestjs/common';
import { QueueManagerService } from './queue.service';

@Global()
@Module({
  providers: [QueueManagerService],
  exports: [QueueManagerService],
})
export class QueueModule {}
