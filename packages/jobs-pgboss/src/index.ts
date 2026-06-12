import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import type { JobRunner } from "@samesake/server";

type PendingJob<T> = {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

export interface PgBossRunnerOptions {
  connectionString: string;
  schema?: string;
}

export async function createPgBossRunner(
  opts: PgBossRunnerOptions
): Promise<JobRunner & { stop: () => Promise<void> }> {
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    schema: opts.schema ?? "pgboss",
  });
  await boss.start();

  const pending = new Map<string, PendingJob<unknown>>();
  const queue = "samesake-jobs";

  await boss.createQueue(queue);

  await boss.work(queue, async (jobs) => {
    for (const job of jobs) {
      const jobId = (job.data as { jobId?: string }).jobId;
      if (!jobId) continue;
      const entry = pending.get(jobId);
      if (!entry) continue;
      pending.delete(jobId);
      try {
        const result = await entry.fn();
        entry.resolve(result);
      } catch (e) {
        entry.reject(e);
      }
    }
  });

  return {
    run: <T>(name: string, payload: unknown, fn: () => Promise<T>): Promise<T> => {
      const jobId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(jobId, { fn, resolve: resolve as (v: unknown) => void, reject });
        boss.send(queue, { name, payload, jobId }).catch((e) => {
          pending.delete(jobId);
          reject(e);
        });
      });
    },
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
