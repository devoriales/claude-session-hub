// Writes a release's version into .claude-plugin/plugin.json, which is where
// Claude Code reads a plugin's version. Run by semantic-release (see .releaserc.json).
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error(`usage: node scripts/set-version.mjs <semver>, got ${version}`)
  process.exit(1)
}
const file = new URL('../.claude-plugin/plugin.json', import.meta.url)
const manifest = JSON.parse(readFileSync(file, 'utf8'))
manifest.version = version
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`plugin.json version set to ${version}`)
