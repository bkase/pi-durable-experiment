// Bundle src/worker.ts the way the Workers runtime will load it (for local workerd runs).
import { rolldown } from "rolldown"

const out = process.argv[2] ?? ".local"
const bundle = await rolldown({
  input: "src/worker.ts",
  platform: "neutral",
  external: [/^cloudflare:/, /^node:/],
  resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"], mainFields: ["module", "main"] },
  logLevel: "warn"
})
await bundle.write({ dir: out, format: "esm", codeSplitting: false, minify: true })
console.log(`bundled to ${out}/worker.js`)
