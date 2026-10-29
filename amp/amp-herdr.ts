// managed by amp-herdr (https://github.com/cwkendall/amp-herdr)
// Reinstalling or updating amp-herdr overwrites this file.

import net from 'node:net'
import type { PluginAPI, Subscription, ThreadState } from '@ampcode/plugin'

export const description =
	'Reports the active Amp thread to Herdr: state, title, and the command that resumes it after a Herdr restart.'

const SOURCE = 'amp-herdr'
const AGENT = 'amp'

export function herdrState(state: ThreadState): 'idle' | 'working' | 'blocked' {
	if (state === 'running') return 'working'
	if (state === 'awaiting-approval') return 'blocked'
	return 'idle'
}

export function resumeArgv(threadID: string): string[] {
	return ['amp', 'threads', 'continue', threadID]
}

function send(endpoint: string, request: unknown, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(endpoint)
		const finish = (delivered: boolean) => {
			clearTimeout(timer)
			socket.destroy()
			resolve(delivered)
		}
		const timer = setTimeout(() => finish(false), timeoutMs)
		socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
		socket.on('data', () => finish(true))
		socket.on('error', () => finish(false))
		socket.on('end', () => finish(false))
	})
}

// Sends the latest report per method in order, one request at a time, so a
// slow socket can delay Herdr's view of Amp but never slow Amp down.
function createReporter(endpoint: string, paneID: string) {
	let seq = 0
	const pending = new Map<string, Record<string, unknown>>()
	let draining: Promise<void> | undefined

	async function drain() {
		while (pending.size > 0) {
			const [method, params] = pending.entries().next().value!
			pending.delete(method)
			const request = { id: `${SOURCE}:${params.seq}`, method, params }
			if (!(await send(endpoint, request, 500))) await send(endpoint, request, 1500)
		}
		draining = undefined
	}

	function report(method: string, params: Record<string, unknown>) {
		pending.delete(method)
		// Herdr ignores sequence numbers that are not higher than the last one it saw
		// from this source, which may come from another Amp process in the same pane.
		seq = Math.max(seq + 1, Date.now() * 1000)
		pending.set(method, { pane_id: paneID, source: SOURCE, agent: AGENT, seq, ...params })
		draining ??= drain()
		return draining
	}

	return { report }
}

export default function (amp: PluginAPI) {
	const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID } = process.env
	if (HERDR_ENV !== '1' || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return

	const endpoint =
		process.platform === 'win32' ? `\\\\.\\pipe\\${HERDR_SOCKET_PATH}` : HERDR_SOCKET_PATH
	const { report } = createReporter(endpoint, HERDR_PANE_ID)
	let threadSubscriptions: Subscription[] = []

	// Herdr drops the resume command and title only when the pane is released.
	function release() {
		for (const subscription of threadSubscriptions) subscription.unsubscribe()
		threadSubscriptions = []
		report('pane.report_metadata', { clear_title: true, tokens: { amp_thread: null } })
		return report('pane.release_agent', {})
	}

	amp.activeThread.subscribe((active) => {
		if (!active) {
			if (threadSubscriptions.length > 0) void release()
			return
		}
		for (const subscription of threadSubscriptions) subscription.unsubscribe()

		const thread = amp.threads.get(active.id)
		threadSubscriptions = [
			thread.state.subscribe((state) => {
				report('pane.report_agent', {
					state: herdrState(state),
					message: state === 'awaiting-approval' ? 'Approval required' : undefined,
					agent_session_id: active.id,
					resume_argv: resumeArgv(active.id),
				})
			}),
			thread.title.subscribe((title) => {
				report('pane.report_metadata', {
					...(title ? { title } : { clear_title: true }),
					tokens: { amp_thread: active.id },
				})
			}),
		]
	})

	amp.onDispose(release)
}
