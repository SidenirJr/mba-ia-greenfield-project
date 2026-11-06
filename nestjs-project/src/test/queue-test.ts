import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';

// Prefixo único por execução (TD-12): isola as filas de teste das de dev e de outras suítes.
export const uniqueQueuePrefix = (): string => `test-${randomUUID()}`;

export async function obliterateQueues(...queues: Queue[]): Promise<void> {
  for (const queue of queues) {
    await queue.obliterate({ force: true });
  }
}
