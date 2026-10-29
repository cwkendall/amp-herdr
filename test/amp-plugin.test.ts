import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

type Listener<T> = (value: T) => void

function observable<T>(initial: T) {
	let value = initial
	const listeners = new Set<Listener<T>>()
	return {
		subscribe(listener: Listener<T>) {
			listeners.add(listener)
			listener(value)
			return { unsubscribe: () => listeners.delete(listener) }
		},
		get subscribers() {
			return listeners.size
		},
		emit(next: T) {
			value = next
			for (const listener of listeners) listener(next)
		},
	}
}

async function startHerdr() {
	// Herdr passes a pipe name on Windows, which the plugin turns into \\.\pipe\<name>.
	const socketPath =
		process.platform === 'win32'
			? `amp-herdr-test-${process.pid}-${Math.random().toString(36).slice(2)}`
			: join(mkdtempSync(join(tmpdir(), 'amp-herdr-')), 'herdr.sock')
	const listenPath = process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath
	const requests: any[] = []
	const server = net.createServer((socket) => {
		socket.on('data', (data) => {
			for (const line of data.toString().split('\n').filter(Boolean)) {
				const request = JSON.parse(line)
				requests.push(request)
				socket.write(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(listenPath, resolve))
	return { socketPath, requests, close: () => server.close() }
}

async function loadPlugin(socketPath: string | undefined, agent?: string) {
	Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
	if (agent) process.env.AGENT = agent
	else delete process.env.AGENT
	if (socketPath) process.env.HERDR_SOCKET_PATH = socketPath
	else delete process.env.HERDR_SOCKET_PATH

	const active = observable<{ id: string } | null>(null)
	const threads = new Map<string, { state: ReturnType<typeof observable>; title: ReturnType<typeof observable> }>()
	const disposers: (() => Promise<void>)[] = []
	const amp = {
		activeThread: active,
		threads: {
			get(id: string) {
				if (!threads.has(id)) threads.set(id, { state: observable('idle'), title: observable(null) })
				return threads.get(id)
			},
		},
		onDispose: (callback: () => Promise<void>) => disposers.push(callback),
	}
	const plugin = await import(`../amp/amp-herdr.ts?${Math.random()}`)
	plugin.default(amp)
	return { plugin, active, threads, dispose: () => Promise.all(disposers.map((callback) => callback())) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
const A = 'T-00000000-0000-0000-0000-00000000000a'
const B = 'T-00000000-0000-0000-0000-00000000000b'

test('reports the active thread, follows thread switches, and releases on exit', async () => {
	const herdr = await startHerdr()
	try {
		const { active, threads, dispose } = await loadPlugin(herdr.socketPath)
		active.emit({ id: A })
		await settle()
		threads.get(A)!.state.emit('running')
		threads.get(A)!.title.emit('Fix login')
		await settle()
		threads.get(A)!.state.emit('awaiting-approval')
		await settle()

		active.emit({ id: B })
		threads.get(A)!.state.emit('idle') // the previous thread no longer reports
		await settle()
		threads.get(B)!.state.emit('error')
		await settle()
		await dispose()

		const sent = herdr.requests.map(({ method, params }) => ({ method, ...params }))
		const states = sent.filter((request) => request.method === 'pane.report_agent')
		assert.deepEqual(
			states.map(({ state, resume_argv }) => [state, resume_argv.at(-1)]),
			[
				['idle', A],
				['working', A],
				['blocked', A],
				['idle', B],
				['blocked', B],
			],
		)
		assert.equal(states[2].message, 'Approval required')
		assert.equal(states[4].message, 'Error', 'a failed turn waits for the user')
		assert.deepEqual(states.at(-1).resume_argv, ['amp', 'threads', 'continue', B])
		assert.ok(
			sent.some(
				(request) => request.title === 'Fix login' && request.display_agent === 'amp · Fix login' && request.tokens.amp_thread === A,
			),
		)
		assert.ok(sent.some((request) => request.clear_display_agent && request.tokens.amp_thread === B), 'an untitled thread clears the name')
		assert.ok(sent.some((request) => request.clear_display_agent && request.tokens.amp_thread === null), 'release clears the name')
		assert.deepEqual(sent.at(-1), { method: 'pane.release_agent', pane_id: 'w1:p1', source: 'amp-herdr', agent: 'amp', seq: sent.at(-1).seq })
		for (const request of sent) assert.equal(request.source, 'amp-herdr')
		const seqs = sent.map((request) => request.seq)
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence numbers increase in send order')
	} finally {
		herdr.close()
	}
})

test('sends only the latest pending state when reports queue up', async () => {
	const herdr = await startHerdr()
	try {
		const { active, threads } = await loadPlugin(herdr.socketPath)
		active.emit({ id: A })
		for (const state of ['running', 'awaiting-approval', 'running', 'idle']) threads.get(A)!.state.emit(state)
		await settle()
		const states = herdr.requests.filter((request) => request.method === 'pane.report_agent').map((request) => request.params.state)
		assert.deepEqual(states, ['idle', 'idle'])
	} finally {
		herdr.close()
	}
})

test('does nothing outside Herdr, or in an amp started by another Amp in the same pane', async () => {
	assert.equal((await loadPlugin(undefined)).active.subscribers, 0)
	const herdr = await startHerdr()
	try {
		const nested = await loadPlugin(herdr.socketPath, 'amp')
		assert.equal(nested.active.subscribers, 0)
		await nested.dispose()
		await settle()
		assert.deepEqual(herdr.requests, [], 'the nested amp never releases the pane')
	} finally {
		herdr.close()
	}
})
