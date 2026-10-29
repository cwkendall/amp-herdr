# amp-herdr

[Amp](https://ampcode.com) integration for [Herdr](https://herdr.dev). Herdr
detects Amp from its screen. amp-herdr has Amp report to Herdr directly, the
same way Herdr's built-in integrations do for Pi or OpenCode.

| | Without amp-herdr | With amp-herdr |
| --- | --- | --- |
| Agent state | Read from the screen | Reported by Amp: `working`, `blocked` on approvals, `idle` |
| Server restart | Amp panes come back as empty shells | Herdr reopens the same thread with `amp threads continue <id>` |
| Pane title | Terminal title | Amp thread title |
| Open a thread | Type `amp threads continue` yourself | Pick a recent thread from a popup |
| Threads started elsewhere | Not in Herdr | `sync` opens recent threads in their project workspace |

It works with any Amp deployment, including self-hosted tenancies: it runs the
`amp` on your `PATH` and never talks to the Amp API itself.

## Requirements

- Herdr 0.9.2 or later
- Amp CLI with plugin support
- Node.js 22.18 or later

## Install

From Herdr:

```bash
herdr plugin install cwkendall/amp-herdr
```

This installs the Amp plugin into `~/.config/amp/plugins/`, registers the
Herdr plugin, and adds an `amp-herdr` launcher to `~/.local/bin` unless one is
already on your `PATH`. `herdr plugin update` keeps all three current.

From Homebrew or a checkout:

```bash
amp-herdr install
```

Restart running Amp sessions, or run `plugins: reload` in each, to start
reporting. Check the result with `amp-herdr status`.

## Use

Run Amp in a Herdr pane as usual. The sidebar shows the thread title and
state, and Herdr notifies you when Amp needs approval or finishes. After a
Herdr server restart, reattach and each Amp pane resumes its thread.

The Herdr plugin adds two actions. Bind them to keys in Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "amp-herdr.open"
description = "open Amp thread"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "amp-herdr.sync"
description = "sync Amp threads"
```

The same commands work from a shell:

```text
amp-herdr open [thread-id]        Open a thread, or pick one from recent threads
amp-herdr sync [--since 24h]      Open recently updated threads that are not open yet
                [--dry-run]
amp-herdr upgrade [session]       Stop outdated Herdr sessions that restart safely
                  [--yes]
amp-herdr status                  Show what is installed and what Herdr sees
amp-herdr uninstall               Remove both plugins
```

`open` focuses a thread that is already open instead of opening it twice. New
threads open as a tab in the workspace for their project directory, or in a new
workspace.

### Upgrading Herdr with a package manager

Herdr's live handoff keeps panes running across updates, but only for its own
installer. Homebrew, mise, and Nix updates leave old servers running until they
stop. After such an update, run:

```bash
amp-herdr upgrade
```

It checks every running session, or the one you name. A session stops only
when it is outdated and every pane survives the restart: an idle shell, an
agent Herdr can resume natively, or an Amp pane reporting its thread. It lists
anything else, such as a dev server or an Amp session started before this
plugin was installed, and leaves that session running. It asks once before
stopping anything and never starts a terminal; reattach with
`herdr --session <name>`.

## How it works

`amp/amp-herdr.ts` is an Amp plugin. Inside a Herdr pane it follows the thread
you are viewing and reports it through Herdr's
[agent reporting API](https://herdr.dev/docs/add-herdr-support/):

- `pane.report_agent` with the thread state and
  `resume_argv = ["amp", "threads", "continue", "<thread-id>"]`
- `pane.report_metadata` with the thread title and an `amp_thread` token
- `pane.release_agent` when Amp exits

Outside Herdr it does nothing. Reports are queued and coalesced so a slow
socket never slows Amp down.

`herdr-plugin.toml` declares the Herdr plugin. Its build and startup hooks keep
the Amp plugin current, and its actions run `bin/amp-herdr`, which uses the
`herdr` and `amp` CLIs.

## Development

```bash
npm test
herdr plugin link .   # use this checkout as the Herdr plugin
```

Test end to end in a separate named session such as
`herdr --session amp-herdr-test`, so a restart does not affect your work.

## License

Apache-2.0
