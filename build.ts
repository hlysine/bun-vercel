import { exists, mkdir, unlink } from "node:fs/promises"
import { parseArgs } from "util"
import { getTransformedRoutes } from "@vercel/routing-utils"
import { $ } from "bun"

// Ex. ./src/main.ts
const args = Bun.argv.slice(2)
const { values: options, positionals } = parseArgs({
  args,
  options: {
    funcPath: {
      type: "string",
      multiple: false,
      short: "f",
      default: "api",
    },
  },
  strict: true,
  allowPositionals: true,
})
options.funcPath ??= "api"

if (positionals.length === 0) {
  throw new Error("missing main module path")
}

const mainModulePath = positionals[0]

// Ensure file exists
if ((await exists(mainModulePath)) !== true) {
  throw new Error(`module not found: ${mainModulePath}`)
}

// Get current architecture for build
const arch = process.arch === "arm64" ? "arm64" : "x86_64"

// Bootstrap source should be in same directory as main
const bootstrapSourcePath = mainModulePath.replace(
  /\.(ts|js|cjs|mjs)$/,
  ".bootstrap.ts",
)

// Read in bootstrap source
const bootstrapSource = await Bun.file("node_modules/bun-vercel/bootstrap.ts")
  .text()
  .catch(() => Bun.file("bootstrap.ts").text())

// Write boostrap source to bootstrap file
await Bun.write(
  bootstrapSourcePath,
  bootstrapSource.replace(
    'import main from "./example/main"',
    `import main from "./${mainModulePath.split("/").pop()}"`,
  ),
)

// Create output directory
await mkdir(`./.vercel/output/functions/${options.funcPath}.func`, {
  recursive: true,
})

// Create function config file
await Bun.write(
  `./.vercel/output/functions/${options.funcPath}.func/.vc-config.json`,
  JSON.stringify(
    {
      architecture: arch,
      handler: "bootstrap",
      maxDuration: 10,
      memory: 1024,
      runtime: "provided.al2",
      supportsWrapper: false,
    },
    null,
    2,
  ),
)

// Create routing config file
const configFile = Bun.file("vercel.json")
let routes
let vercelConfig
if (await configFile.exists()) {
  vercelConfig = await configFile.json()
  ;({ routes } = getTransformedRoutes(vercelConfig))
} else {
  routes = [
    {
      headers: {
        Location: "/$1",
      },
      src: "^(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))/$",
      status: 308,
    },
    {
      handle: "filesystem",
    },
    {
      check: true,
      dest: options.funcPath,
      src: "^.*$",
    },
  ]
}
await Bun.write(
  "./.vercel/output/config.json",
  JSON.stringify(
    {
      framework: {
        version: Bun.version,
      },
      overrides: {},
      routes,
      version: 3,
    },
    null,
    2,
  ),
)

// Copy static files to output directory
if (vercelConfig?.outputDirectory) {
  await $`cp -r ${vercelConfig.outputDirectory} ./.vercel/output/static`
}

// Compile to a single bun executable
if (await exists("/etc/system-release")) {
  await $`bun build ${bootstrapSourcePath} --compile --minify --outfile .vercel/output/functions/${options.funcPath}.func/bootstrap`
} else {
  await $`docker run --platform linux/${arch} --rm -v ${process.cwd()}:/app -w /app oven/bun bash -cl 'bun build ${bootstrapSourcePath} --compile --minify --outfile .vercel/output/functions/${
    options.funcPath
  }.func/bootstrap'`
}

// Cleanup bootstrap file
await unlink(bootstrapSourcePath)
