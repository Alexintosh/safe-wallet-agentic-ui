import { cp, mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist/agent-safe-source");
try { await access(target); throw new Error("Export target exists; choose a fresh directory"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
await mkdir(target, { recursive: true });
for (const path of ["apps/agent-safe", "apps/agent-safe-web", "packages/safe-core", "packages/safe-fork", "packages/agent-safe-application", "packages/agent-safe-storage", "plugins/agent-safe", "tests/agent-safe"])
  await cp(join(root, path), join(target, path), { recursive: true, filter: source => !source.split("/").some(segment => ["node_modules", "build"].includes(segment)) });
for (const path of ["scripts/build-agent-safe.ts", "scripts/export-agent-safe.ts", "tsconfig.agent-safe.json"]) { await mkdir(resolve(target, path, ".."), { recursive: true }); await cp(join(root, path), join(target, path)); }
await writeFile(join(target, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", lib: ["ESNext", "DOM"], types: ["bun"], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true } }, null, 2));
await writeFile(join(target, "package.json"), JSON.stringify({ name: "agent-safe", version: "0.1.10", private: true, type: "module", workspaces: ["apps/*", "packages/*"], scripts: { build: "bun scripts/build-agent-safe.ts", typecheck: "tsc --noEmit -p tsconfig.agent-safe.json", test: "bun test tests/agent-safe", check: "bun run typecheck && bun test tests/agent-safe" }, dependencies: { "@safe-global/protocol-kit": "8.0.4", "@safe-global/types-kit": "4.0.1", viem: "2.55.1", elysia: "1.4.29", "@elysia/openapi": "1.4.15" }, devDependencies: { "@metamask/eth-sig-util": "9.0.0", "@types/bun": "1.3.14", typescript: "7.0.2" }, engines: { bun: ">=1.3.8" } }, null, 2));
await cp(join(root, "README.md"), join(target, "README.md"));
await cp(join(root, "PLAN.md"), join(target, "PLAN.md"));
for (const path of ["AGENTS.md", ".gitignore", "bun.lock", "package.json", "docs"]) await cp(join(root, path), join(target, path), { recursive: true });
console.log(JSON.stringify({ target, next: "bun install, bun run check, bun run build. Publish only this directory or plugins/agent-safe." }));
