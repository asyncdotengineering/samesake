import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

type PackEntry = { path: string; size: number };
type PackResult = { name: string; version: string; files: PackEntry[] };

const packages: { dir: string; requireTypes: boolean }[] = [
  { dir: "packages/sdk", requireTypes: true },
  { dir: "packages/server", requireTypes: true },
  { dir: "packages/cli", requireTypes: false },
  { dir: "packages/jobs-pgboss", requireTypes: true },
];

let failed = false;

function fail(msg: string): void {
  console.error(`FAIL ${msg}`);
  failed = true;
}

for (const { dir } of packages) {
  const pkgRoot = join(repoRoot, dir);
  execSync("bun run build", { cwd: pkgRoot, stdio: "inherit" });
}

const tarballs = new Map<string, string>();
const tmpPack = mkdtempSync(join(tmpdir(), "samesake-pack-"));

try {
  for (const { dir, requireTypes } of packages) {
    const pkgRoot = join(repoRoot, dir);
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
      files?: string[];
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const raw = execSync("npm pack --dry-run --json", {
      cwd: pkgRoot,
      encoding: "utf8",
    });
    const [result] = JSON.parse(raw) as PackResult[];
    const paths = result.files.map((f) => f.path);

    console.log(`${pkg.name}@${pkg.version}: ${paths.length} files`);

    for (const depRecord of [pkg.dependencies, pkg.peerDependencies]) {
      if (!depRecord) continue;
      for (const [dep, range] of Object.entries(depRecord)) {
        if (range.includes("workspace:")) {
          fail(`${pkg.name}: workspace protocol in manifest: ${dep}@${range}`);
        }
      }
    }

    for (const p of paths) {
      if (p.endsWith(".map")) fail(`${pkg.name}: sourcemap in tarball: ${p}`);
      if (p.startsWith("src/") || p.includes("/test/") || p.startsWith("test/")) {
        fail(`${pkg.name}: src/test leak: ${p}`);
      }
    }

    if (!paths.some((p) => p === "LICENSE" || p.endsWith("/LICENSE"))) {
      fail(`${pkg.name}: LICENSE missing from tarball`);
    }

    if (requireTypes) {
      const hasTypes = paths.some((p) => p.endsWith(".d.ts") || p.endsWith(".d.cts"));
      if (!hasTypes) fail(`${pkg.name}: no .d.ts/.d.cts in tarball`);
    } else {
      const hasDist = paths.some((p) => p.startsWith("dist/") && p.endsWith(".js"));
      if (!hasDist) fail(`${pkg.name}: no dist/*.js in tarball`);
    }

    const allowed = new Set([...(pkg.files ?? ["dist"]), "package.json"]);
    for (const p of paths) {
      const top = p.split("/")[0]!;
      if (!allowed.has(top)) {
        fail(`${pkg.name}: unexpected top-level path "${top}" (not in files whitelist)`);
      }
    }

    const tgzName = execSync(`npm pack --pack-destination ${tmpPack}`, {
      cwd: pkgRoot,
      encoding: "utf8",
    }).trim();
    tarballs.set(pkg.name, join(tmpPack, tgzName));

    const packedPkg = JSON.parse(
      execSync(`tar -xOf ${join(tmpPack, tgzName)} package/package.json`, {
        encoding: "utf8",
      })
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    for (const depRecord of [packedPkg.dependencies, packedPkg.peerDependencies]) {
      if (!depRecord) continue;
      for (const [dep, range] of Object.entries(depRecord)) {
        if (range.includes("workspace:")) {
          fail(`${pkg.name}: workspace protocol in packed tarball: ${dep}@${range}`);
        }
      }
    }
  }

  if (!failed) {
    const installDir = join(tmpPack, "consumer");
    mkdirSync(installDir);
    const deps: Record<string, string> = {};
    for (const [name, path] of tarballs) {
      deps[name] = `file:${path}`;
    }
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "samesake-consumer-smoke", private: true, type: "module", dependencies: deps }, null, 2)
    );
    writeFileSync(
      join(installDir, "smoke.mjs"),
      `import "@samesake/core";\nimport "@samesake/server";\nimport "@samesake/jobs-pgboss";\n`
    );
    execSync("npm install --ignore-scripts", { cwd: installDir, stdio: "inherit" });
    execSync("node smoke.mjs", { cwd: installDir, stdio: "inherit" });
    console.log("pack-assert: npm install smoke passed");
  }
} finally {
  rmSync(tmpPack, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("pack-assert: all packages clean");
