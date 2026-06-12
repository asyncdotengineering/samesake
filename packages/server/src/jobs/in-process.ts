import type { JobRunner } from "../types.ts";

export const inProcessRunner: JobRunner = {
  run: (_name, _payload, fn) => fn(),
};
