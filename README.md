# pi-daytona

Run pi safely inside a [Daytona](https://daytona.io) cloud sandbox. Every file read, write, shell command, and search runs in an isolated container — your local machine is never touched.

## Why sandboxing?

When pi edits files or runs bash commands, it operates directly on your machine. A sandbox moves all of that into a secure, disposable cloud environment. If the AI does something unexpected, your real filesystem stays safe. Think of it as a safety net — you can experiment freely and throw the sandbox away when you're done.

## Setup

**1. Get a Daytona API key**

Sign up at [daytona.io](https://daytona.io) and grab an API key from the dashboard.

**2. Configure pi**

Create `~/.pi/daytona.json`:

```json
{
  "daytonaApiKey": "dtn_YOUR_KEY_HERE"
}
```

**3. Install**

```bash
pi install npm:pi-daytona
```

## Usage

```bash
# Create a fresh sandbox
pi --sandbox

# Create a named sandbox you can return to
pi --sandbox my-project

# Reconnect to an existing sandbox
pi --sandbox my-project

# Disable sandboxing for a session
pi --sandbox --no-sandbox
```

Once connected, pi works exactly the same — just safer. All file operations and commands run in the cloud. The status bar shows your sandbox name.

## Cleanup

Sandboxes don't auto-delete. To clean up, ask pi:

```
List my sandboxes, then delete the ones I'm done with
```

Or use these tools directly:

- **sandbox-list** — shows all your pi sandboxes with name, ID, and state
- **sandbox-delete** — delete one or more sandboxes by name or ID

Sandboxes auto-stop after 30 minutes of inactivity so you won't get unexpected bills, but they stick around until you delete them.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `daytonaApiKey` | (required) | Your Daytona API key |
| `daytonaApiUrl` | `https://app.daytona.io/api` | API endpoint |
| `daytonaTarget` | `us` | Region (`us` or `eu`) |

## Changelog

### v0.0.1

- **Per-session sandbox state**: Replaced module-level globals with a `Map<string, SessionState>` keyed
  by `sessionManager.getSessionId()`. Each session now manages its own independent sandbox.
- **Concurrent sessions**: Multiple pi sessions (e.g., in an HTTP server) can now use different
  sandboxes simultaneously.
- **session_shutdown handler**: Properly cleans up per-session state when a session is replaced or closed.
- **sandbox-list**: Shows all active sandboxes across all sessions.
- **sandbox-delete**: Detaches only the affected sessions instead of killing a global state.

### v0.0.0

- Initial release with module-level global state (single sandbox per process).

## Requirements

- Node.js ≥ 18
- A Daytona account

## License

MIT
