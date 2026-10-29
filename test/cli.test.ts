import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'bin', 'amp-herdr')

// Fake herdr and amp executables answer from a JSON world and log every call.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'))
let args = process.argv.slice(2)
const tool = require('node:path').basename(process.argv[1])
let session = 'default'
if (args[0] === '--session') { session = args[1]; args = args.slice(2) }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify([tool, session, ...args]) + '\\n')
const out = (result) => process.stdout.write(JSON.stringify(tool === 'amp' ? result : { result }))
const s = world.sessions?.[session]
const key = args.slice(0, 2).join(' ')
if (tool === 'pgrep') process.exit((world.childrenOf ?? []).includes(Number(args[1])) ? 0 : 1)
if (tool === 'amp') out(key === 'threads list' ? world.threads : world.exports[args[2]])
else if (key === 'session list') out({ sessions: Object.entries(world.sessions).map(([name, v]) => ({ name, running: v.running, socket_path: '/sock/' + name })) })
else if (key === 'status client') out({ version: world.version })
else if (key === 'status server') out({ version: s.version, restart_needed: false, server_binary_stale: false })
else if (key === 'pane list') out({ panes: s.panes })
else if (key === 'pane process-info') out({ process_info: s.processes[args[3]] })
else if (key === 'plugin list') out({ plugins: world.plugins ?? [] })
else if (key === 'workspace create') out({ workspace: { workspace_id: 'wNEW' }, tab: { tab_id: 'wNEW:t1' }, root_pane: { pane_id: 'wNEW:p1' } })
else if (key === 'tab create') out({ root_pane: { pane_id: args[3] + ':pNEW' } })
else out({ ok: true })
`

function setup(world: object) {
	const dir = mkdtempSync(join(tmpdir(), 'amp-herdr-cli-'))
	mkdirSync(join(dir, 'bin'))
	for (const tool of ['herdr', 'amp', 'pgrep']) {
		writeFileSync(join(dir, 'bin', tool), FAKE)
		chmodSync(join(dir, 'bin', tool), 0o755)
	}
	writeFileSync(join(dir, 'world.json'), JSON.stringify(world))
	const env = {
		...process.env,
		PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
		FAKE_WORLD: join(dir, 'world.json'),
		FAKE_LOG: join(dir, 'calls.log'),
		XDG_CONFIG_HOME: join(dir, 'config'),
		HERDR_SOCKET_PATH: '',
		HERDR_BIN_PATH: '',
		HERDR_PLUGIN_ID: '',
	}
	const cli = (...args: string[]) => {
		const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', input: '' })
		const calls = existsSync(env.FAKE_LOG)
			? readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
			: []
		writeFileSync(env.FAKE_LOG, '')
		return { ...result, calls }
	}
	return { dir, cli }
}

const shell = (pid: number) => ({ foreground_process_group_id: pid, shell_pid: pid, foreground_processes: [{ name: 'zsh' }] })
const busy = { foreground_process_group_id: 20, shell_pid: 11, foreground_processes: [{ name: 'zsh' }, { name: 'node' }] }
const amp = { foreground_process_group_id: 30, shell_pid: 12, foreground_processes: [{ name: 'amp' }] }

function upgradeWorld() {
	return {
		version: '0.9.5',
		childrenOf: [13], // shell 13 has a suspended or background job
		sessions: {
			current: { running: true, version: '0.9.5', panes: [], processes: {} },
			safe: {
				running: true,
				version: '0.9.4',
				panes: [
					{ pane_id: 'w1:p1', cwd: '/a' },
					{ pane_id: 'w1:p2', cwd: '/a', agent: 'amp', agent_status: 'idle', tokens: { amp_thread: 'T-1' } },
					{ pane_id: 'w1:p3', cwd: '/b', agent: 'claude', agent_status: 'done', agent_session: { value: 'x' } },
					{ pane_id: 'w1:p4', cwd: '/c' },
				],
				processes: { 'w1:p1': shell(10), 'w1:p2': amp, 'w1:p3': busy, 'w1:p4': { foreground_processes: [] } },
			},
			busy: {
				running: true,
				version: '0.9.4',
				panes: [
					{ pane_id: 'w1:p1', cwd: '/srv' },
					{ pane_id: 'w1:p2', cwd: '/old', agent: 'amp', agent_status: 'idle' },
					{ pane_id: 'w1:p3', cwd: '/bg' },
					{ pane_id: 'w1:p4', cwd: '/crashed', agent_status: 'idle', tokens: { amp_thread: 'T-2' } },
					{ pane_id: 'w1:p5', cwd: '/turn', agent: 'amp', agent_status: 'working', tokens: { amp_thread: 'T-3' } },
					{ pane_id: 'w1:p6', cwd: '/unknown' },
				],
				processes: {
					'w1:p1': busy,
					'w1:p2': amp,
					'w1:p3': shell(13),
					'w1:p4': busy,
					'w1:p6': { shell_pid: 14, foreground_processes: [] },
				},
			},
			stopped: { running: false },
		},
	}
}

const stops = (calls: string[][]) => calls.filter((call) => call[2] === 'session' && call[3] === 'stop').map((call) => call[4])

test('upgrade stops only outdated sessions whose panes all survive a restart', () => {
	const { cli } = setup(upgradeWorld())
	const result = cli('upgrade', '--yes')
	assert.equal(result.status, 1, 'a blocked session makes the command fail')
	assert.deepEqual(stops(result.calls), ['safe'])
	assert.match(result.stdout, /current is current/)
	assert.match(result.stdout, /busy \(0\.9\.4\) cannot restart safely/)
	assert.match(result.stdout, /w1:p1 \(\/srv\) is running zsh, node/)
	assert.match(result.stdout, /w1:p2 \(\/old\) is running amp/, 'Amp without a reported thread is not resumable')
	assert.match(result.stdout, /w1:p3 \(\/bg\) is running zsh/, 'a background or suspended job blocks')
	assert.match(result.stdout, /w1:p4 \(\/crashed\) is running zsh, node/, 'a token left by an exited Amp is ignored')
	assert.match(result.stdout, /w1:p5 \(\/turn\): amp is working/, 'an agent mid-turn blocks')
	assert.match(result.stdout, /w1:p6 \(\/unknown\) is running a job Herdr cannot inspect/)
})

test('upgrade honours a session name and asks before stopping', () => {
	const { cli } = setup(upgradeWorld())
	assert.deepEqual(stops(cli('upgrade', 'busy', '--yes').calls), [])
	const unconfirmed = cli('upgrade', 'safe')
	assert.equal(unconfirmed.status, 1)
	assert.match(unconfirmed.stderr, /rerun with --yes/)
	assert.deepEqual(stops(unconfirmed.calls), [])
	assert.match(cli('upgrade', 'missing').stderr, /missing is not running/)
})

test('sync opens recent threads that are not open, reusing workspaces by directory', () => {
	const project = mkdtempSync(join(tmpdir(), 'project-'))
	const other = mkdtempSync(join(tmpdir(), 'other-'))
	const now = Date.now()
	const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600000).toISOString()
	const ids: Record<string, string> = {}
	const tid = (name: string) => (ids[name] ??= `T-00000000-0000-0000-0000-${String(Object.keys(ids).length + 1).padStart(12, '0')}`)
	const thread = (name: string, hoursAgo: number, dir?: string) => ({
		id: tid(name),
		title: `Thread ${name}`,
		updated: iso(hoursAgo),
		tree: dir ? pathToFileURL(dir).href : undefined,
	})
	const { dir, cli } = setup({
		sessions: {
			default: {
				running: true,
				panes: [
					{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: project, agent: 'amp', tokens: { amp_thread: tid('T-open') } },
				],
			},
		},
		threads: [
			{ id: 'T-x; rm -rf ~', title: 'hostile', updated: iso(1), tree: pathToFileURL(project).href },
			thread('T-open', 1, project),
			thread('T-same-dir', 2, project),
			thread('T-new-dir', 3, other),
			thread('T-no-dir', 1),
			thread('T-gone', 1, join(other, 'deleted')),
			thread('T-old', 30, project),
		],
	})

	const hostile = cli('sync')
	assert.equal(hostile.status, 1, 'a malformed thread ID aborts before typing anything')
	assert.ok(!hostile.calls.some((call) => call[3] === 'run'))
	const world = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'))
	world.threads.shift()
	writeFileSync(join(dir, 'world.json'), JSON.stringify(world))

	const dry = cli('sync', '--dry-run')
	assert.equal(dry.status, 0, dry.stderr)
	assert.ok(!dry.calls.some((call) => ['run', 'create'].includes(call[3])), 'dry run changes nothing')

	const { calls, stdout } = cli('sync')
	const runs = calls.filter((call) => call[3] === 'run').map((call) => call.slice(4))
	assert.deepEqual(runs, [
		['w1:pNEW', `amp threads continue ${tid('T-same-dir')}`],
		['wNEW:p1', `amp threads continue ${tid('T-new-dir')}`],
	])
	assert.ok(calls.some((call) => call[2] === 'tab' && call[3] === 'create' && call.includes('w1')), 'same directory opens a tab')
	assert.ok(calls.some((call) => call[2] === 'workspace' && call.includes(other)), 'new directory opens a workspace')
	assert.ok(calls.every((call) => !call.includes('--focus')), 'sync never steals focus')
	assert.match(stdout, /Opened 2 thread\(s\).*1 already open; 2 skipped/)
})

test('install never overwrites an Amp plugin it does not manage, and uninstall removes only its own', () => {
	const { dir, cli } = setup({ sessions: {}, plugins: [] })
	const target = join(dir, 'config', 'amp', 'plugins', 'amp-herdr.ts')

	const installed = cli('install')
	assert.equal(installed.status, 0, installed.stderr)
	assert.ok(readFileSync(target, 'utf8').includes('managed by amp-herdr'))
	assert.ok(installed.calls.some((call) => call[2] === 'plugin' && call[3] === 'link'))

	assert.equal(cli('uninstall').status, 0)
	assert.ok(!existsSync(target))

	writeFileSync(target, 'export default () => {}\n')
	const refused = cli('install')
	assert.equal(refused.status, 1)
	assert.match(refused.stderr, /not managed by amp-herdr/)
	cli('uninstall')
	assert.ok(existsSync(target), 'uninstall leaves unmanaged files alone')
})
