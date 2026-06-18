import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";

const repoRoot = join(import.meta.dir, "..");
let failed = false;

function fail(message: string): void {
  console.error(`FAIL ${message}`);
  failed = true;
}

function trackedFiles(): string[] {
  return execSync("git ls-files --cached --others --exclude-standard", { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => existsSync(join(repoRoot, file)))
    .filter((file) => !file.includes("/node_modules/"));
}

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function isArchived(rel: string): boolean {
  // archive / prior-art / research are NOT current docs — they intentionally discuss
  // surveyed options (ParadeDB, alternative licenses, etc.), so the current-doc staleness,
  // link, and naming checks do not apply to them.
  return (
    rel.startsWith("docs/archive/") ||
    rel.startsWith("docs/prior-art/") ||
    rel.startsWith("docs/research/")
  );
}

function existsFileOrDir(abs: string): boolean {
  return existsSync(abs) && (statSync(abs).isFile() || statSync(abs).isDirectory());
}

function resolveLocalPath(fromRel: string, target: string): string | null {
  if (
    !target ||
    target.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return null;
  }
  const withoutHash = target.split("#")[0]!;
  if (!withoutHash) return null;
  const base = withoutHash.startsWith(".") ? dirname(join(repoRoot, fromRel)) : repoRoot;
  return normalize(resolve(base, withoutHash));
}

function checkCanonicalNaming(files: string[]): void {
  const deprecatedName = ["find", "able"].join("");
  for (const rel of files) {
    if (rel === "scripts/release-drift-gates.ts") continue;
    if (isArchived(rel)) continue;
    if (!/\.(md|ts|tsx|js|json|toml|example)$/.test(rel) && rel !== ".env.example") continue;
    const text = read(rel);
    if (new RegExp(`\\b${deprecatedName}\\b|${deprecatedName}\\.config`, "i").test(text)) {
      fail(`${rel}: deprecated project naming in current source/docs`);
    }
  }
  for (const rel of files) {
    if (rel.endsWith(`${deprecatedName}.config.ts`)) {
      fail(`${rel}: config file must be named samesake.config.ts`);
    }
  }
}

function checkStaleCurrentDocs(files: string[]): void {
  const stale = [
    "Elysia",
    "Eden",
    "ParadeDB",
    "BullMQ",
    "Dragonfly",
    "providers.gemini",
    "Apache 2.0",
    "bulk-import",
    "@samesake/sdk",
  ];
  for (const rel of files) {
    if (!(rel === "README.md" || rel.startsWith("docs/")) || isArchived(rel)) continue;
    const text = read(rel);
    for (const term of stale) {
      if (text.includes(term)) {
        fail(`${rel}: stale current-doc reference "${term}"`);
      }
    }
  }
}

function checkMarkdownLocalLinks(files: string[]): void {
  const markdown = files.filter(
    (rel) => rel.endsWith(".md") && !isArchived(rel) && (rel === "README.md" || rel.startsWith("docs/"))
  );
  const linkRe = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const pathLiteralRe = /`((?:\.{1,2}\/)?(?:examples|docs|scripts|packages|apps|deploy)\/[A-Za-z0-9_./@-]+)`/g;

  for (const rel of markdown) {
    const text = read(rel);
    for (const match of text.matchAll(linkRe)) {
      const raw = match[1]!;
      const abs = resolveLocalPath(rel, raw);
      if (abs && abs.startsWith(repoRoot) && !existsFileOrDir(abs)) {
        fail(`${rel}: broken markdown link ${raw}`);
      }
    }
    for (const match of text.matchAll(pathLiteralRe)) {
      const raw = match[1]!;
      const abs = resolveLocalPath(rel, raw);
      if (abs && abs.startsWith(repoRoot) && !existsFileOrDir(abs)) {
        fail(`${rel}: broken documented path ${raw}`);
      }
    }
  }
}

function resolveImport(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(join(repoRoot, fromRel)), spec);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.js`, `${base}.json`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function checkExampleImports(files: string[]): void {
  const exampleFiles = files.filter((rel) => rel.startsWith("examples/") && rel.endsWith(".ts"));
  const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;

  for (const rel of exampleFiles) {
    const text = read(rel);
    for (const re of [importRe, dynamicImportRe]) {
      for (const match of text.matchAll(re)) {
        const spec = match[1]!;
        const abs = resolveImport(rel, spec);
        if (abs && abs.startsWith(repoRoot) && !existsSync(abs)) {
          fail(`${rel}: missing local import ${spec}`);
        }
      }
    }
  }
}

function checkCliInitImport(): void {
  const out = join(repoRoot, "examples/quickstart/.samesake-config-smoke.ts");
  rmSync(out, { force: true });
  try {
    execFileSync("bun", [
      "packages/cli/src/index.ts",
      "init",
      "--name=review_smoke",
      `--out=${out}`,
    ], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("bun", ["-e", `await import(${JSON.stringify(out)})`], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    fail(`CLI init/import smoke failed: ${err.stderr?.toString() || err.stdout?.toString() || err.message || e}`);
  } finally {
    rmSync(out, { force: true });
  }
}

const files = trackedFiles();
checkCanonicalNaming(files);
checkStaleCurrentDocs(files);
checkMarkdownLocalLinks(files);
checkExampleImports(files);
checkCliInitImport();

if (failed) process.exit(1);
console.log("release-drift-gates: docs, examples, naming, and CLI init are aligned");
