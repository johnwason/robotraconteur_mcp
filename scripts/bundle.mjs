// Bundle the server and everything it uses into one file, which runs with Node.js alone:
//   node dist-bundle/robotraconteur-mcp.mjs [config.json]
// The licenses of the bundled packages are written next to it.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bundle");
mkdirSync(out, { recursive: true });

const result = await build({
    entryPoints: [join(root, "src/index.ts")],
    outfile: join(out, "robotraconteur-mcp.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // ws is CommonJS and uses require, which an ES module does not have
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from \"node:module\";\nconst require = __createRequire(import.meta.url);" },
    // ws is found here, since it is only a dependency of robotraconteur-node
    nodePaths: [join(root, "node_modules")],
    // Optional native speedups of ws, which it does without
    external: ["bufferutil", "utf-8-validate"],
    metafile: true,
    logLevel: "warning"
});

// The license of each package that ended up in the bundle
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs))
{
    // Some packages have a package.json with only a type field inside their folders, so look for one with a name
    const named = (d) => existsSync(join(d, "package.json")) && JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name;
    let dir = dirname(join(process.cwd(), input));
    while (dir !== dirname(dir) && !named(dir)) dir = dirname(dir);
    if (!packages.has(dir)) packages.set(dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
}
const notices = [];
for (const [dir, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name)))
{
    const license_file = readdirSync(dir).find((f) => /^(license|licence|copying)(\.|$)/i.test(f));
    const text = license_file ? readFileSync(join(dir, license_file), "utf8").trim() : `License: ${pkg.license ?? "see the package"}`;
    notices.push(`${pkg.name} ${pkg.version}\n${"-".repeat(40)}\n${text}\n`);
}
writeFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), "Packages included in robotraconteur-mcp.mjs, and their licenses.\n\n" + notices.join("\n"));
console.log(`Bundled ${packages.size} packages: ${[...packages.values()].map((p) => p.name).join(", ")}`);
console.log(`Wrote ${relative(root, join(out, "robotraconteur-mcp.mjs")).split(sep).join("/")}`);
