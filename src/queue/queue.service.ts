import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { getQueue, addJob, closeQueues } from './queueManager';
import { initWorkers } from './workers';

@Injectable()
export class QueueManagerService implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    initWorkers();
  }

  getQueue(name: string): any {
    return getQueue(name);
  }

  async addJob(queueName: string, data: any, opts?: any): Promise<any> {
    return addJob(queueName, data, opts);
  }

  async onModuleDestroy(): Promise<void> {
    await closeQueues();
  }
}
