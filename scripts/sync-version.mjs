// Run by `npm version`: copies the new package.json version into the Herdr manifest.
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = readFileSync('herdr-plugin.toml', 'utf8')
writeFileSync('herdr-plugin.toml', manifest.replace(/^version = ".*"$/m, `version = "${version}"`))
