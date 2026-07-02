import { readFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.SAMESAKE_DATABASE_URL) {
  try {
    const envPath = join(import.meta.dir, "../../../.env");
    const env = readFileSync(envPath, "utf8");
    for (const line of env.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (key === "SAMESAKE_DATABASE_URL" && !process.env.SAMESAKE_DATABASE_URL) {
        process.env.SAMESAKE_DATABASE_URL = val;
      }
    }
  } catch {
    // no .env — integration tests skip via describeIf
  }
}
