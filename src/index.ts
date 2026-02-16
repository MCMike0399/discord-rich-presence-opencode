import type { Plugin } from "@opencode-ai/plugin"
import { Client } from "@xhayper/discord-rpc"

/**
 * OpenCode Discord Rich Presence Plugin
 *
 * Shows "Playing OpenCode" on your Discord profile with the current
 * project name and a detailed real-time status of what the agent is doing.
 *
 * State Management:
 *   - Reconnects automatically if Discord is restarted or the IPC drops
 *   - Heartbeat every 15s re-sends the last known presence so it never goes stale
 *   - Clears presence synchronously on process exit via SIGINT/SIGTERM
 *   - Persists last known state so it can be restored after reconnect
 *
 * Prerequisites:
 *   1. Create a Discord Application at https://discord.com/developers/applications
 *   2. Set the application name to "OpenCode" (this becomes the "Playing ..." text)
 *   3. Upload a Rich Presence art asset named "opencode_logo"
 *   4. Set the DISCORD_RPC_CLIENT_ID env var to your application's Client ID
 */

// ─── Configuration ──────────────────────────────────────────────────────────
const CLIENT_ID = process.env.DISCORD_RPC_CLIENT_ID
const LARGE_IMAGE_KEY = "opencode_logo"
const LARGE_IMAGE_TEXT = "OpenCode - AI Coding Agent"
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_INTERVAL_MS = 10_000

// ─── Tool → Status mapping ─────────────────────────────────────────────────
const TOOL_STATUS: Record<string, string> = {
  bash: "Running shell commands",
  edit: "Editing code",
  write: "Writing files",
  patch: "Applying patches",
  read: "Reading files",
  grep: "Searching codebase",
  glob: "Finding files by pattern",
  list: "Browsing directories",
  lsp: "Querying LSP (code intelligence)",
  skill: "Loading agent skill",
  webfetch: "Fetching web content",
  websearch: "Searching the web",
  todowrite: "Updating task list",
  todoread: "Reviewing tasks",
  question: "Asking a question",
}

// ─── Command → Status mapping ───────────────────────────────────────────────
const COMMAND_STATUS: Record<string, string> = {
  init: "Initializing project (AGENTS.md)",
  undo: "Undoing last change",
  redo: "Redoing change",
  share: "Sharing session",
  unshare: "Unsharing session",
  compact: "Compacting context",
  summarize: "Compacting context",
  connect: "Connecting a provider",
  new: "Starting new session",
  clear: "Starting new session",
  models: "Browsing models",
  themes: "Browsing themes",
  sessions: "Switching sessions",
  resume: "Resuming session",
  continue: "Resuming session",
  export: "Exporting conversation",
  editor: "Composing in editor",
  help: "Viewing help",
  details: "Toggling tool details",
  thinking: "Toggling thinking view",
}

// ─── Presence Manager ───────────────────────────────────────────────────────
// Centralizes all RPC state, reconnection logic, and heartbeating.
class PresenceManager {
  private client: Client | null = null
  private connected = false
  private connecting = false
  private destroyed = false

  // Last known presence so we can re-send it after reconnect
  private lastActivity: {
    details: string
    state: string
    startTimestamp: Date
  } | null = null

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setInterval> | null = null

  public sessionStart: Date = new Date()
  public filesEdited = 0
  public commandsRun = 0

  constructor(private projectName: string) {}

  // ── Connect ─────────────────────────────────────────────────────────────
  async connect(): Promise<boolean> {
    if (this.destroyed) return false
    if (this.connected && this.client) return true
    if (this.connecting) return false

    this.connecting = true
    try {
      // Destroy old client if lingering
      if (this.client) {
        try { await this.client.destroy() } catch {}
        this.client = null
      }

      this.client = new Client({ clientId: CLIENT_ID })

      // Listen for the underlying transport closing so we know immediately
      this.client.on("disconnected", () => {
        this.connected = false
        this.startReconnectLoop()
      })

      await this.client.login()
      this.connected = true
      this.connecting = false

      // Stop reconnect loop if it was running
      this.stopReconnectLoop()

      // Re-send last known presence immediately
      if (this.lastActivity) {
        await this.sendActivity(
          this.lastActivity.details,
          this.lastActivity.state,
          this.lastActivity.startTimestamp
        )
      }

      // Start heartbeat
      this.startHeartbeat()

      return true
    } catch {
      this.connected = false
      this.connecting = false
      this.client = null
      this.startReconnectLoop()
      return false
    }
  }

  // ── Update Presence ─────────────────────────────────────────────────────
  async update(state: string, extraDetails?: string): Promise<void> {
    const details = extraDetails
      ? `${this.projectName} · ${extraDetails}`
      : `Working on ${this.projectName}`

    // Always save state even if not connected -- will be sent on reconnect
    this.lastActivity = {
      details,
      state,
      startTimestamp: this.sessionStart,
    }

    if (!this.connected || !this.client) {
      // Try to connect; if it fails the reconnect loop will handle it
      await this.connect()
      return
    }

    await this.sendActivity(details, state, this.sessionStart)
  }

  // ── Clear Presence ──────────────────────────────────────────────────────
  async clear(): Promise<void> {
    this.lastActivity = null
    if (!this.connected || !this.client) return
    try {
      await this.client.user?.clearActivity()
    } catch {}
  }

  // ── Destroy (cleanup on exit) ───────────────────────────────────────────
  async destroy(): Promise<void> {
    this.destroyed = true
    this.stopHeartbeat()
    this.stopReconnectLoop()

    if (this.client) {
      try {
        await this.client.user?.clearActivity()
        await this.client.destroy()
      } catch {}
      this.client = null
    }
    this.connected = false
    this.lastActivity = null
  }

  // Synchronous best-effort cleanup for process exit
  destroySync(): void {
    this.destroyed = true
    this.stopHeartbeat()
    this.stopReconnectLoop()
    // Can't await here, but at least mark everything as dead
    // The RPC socket will be closed when the process exits
    if (this.client) {
      try { this.client.destroy() } catch {}
      this.client = null
    }
    this.connected = false
  }

  // ── Stats ───────────────────────────────────────────────────────────────
  statsLine(): string {
    const parts: string[] = []
    if (this.filesEdited > 0)
      parts.push(`${this.filesEdited} file${this.filesEdited > 1 ? "s" : ""} edited`)
    if (this.commandsRun > 0)
      parts.push(`${this.commandsRun} cmd${this.commandsRun > 1 ? "s" : ""} run`)
    return parts.length > 0 ? parts.join(" · ") : ""
  }

  resetSession(): void {
    this.sessionStart = new Date()
    this.filesEdited = 0
    this.commandsRun = 0
  }

  // ── Internal ────────────────────────────────────────────────────────────
  private async sendActivity(details: string, state: string, startTimestamp: Date): Promise<void> {
    try {
      await this.client!.user?.setActivity({
        details,
        state,
        startTimestamp,
        largeImageKey: LARGE_IMAGE_KEY,
        largeImageText: LARGE_IMAGE_TEXT,
        instance: false,
      })
    } catch {
      // Connection likely dropped
      this.connected = false
      this.startReconnectLoop()
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(async () => {
      if (!this.connected || !this.client || !this.lastActivity) return
      // Re-send the last known presence to keep it alive
      await this.sendActivity(
        this.lastActivity.details,
        this.lastActivity.state,
        this.lastActivity.startTimestamp
      )
    }, HEARTBEAT_INTERVAL_MS)
    // Don't keep the process alive just for the heartbeat
    if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      (this.heartbeatTimer as NodeJS.Timeout).unref()
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startReconnectLoop(): void {
    if (this.destroyed || this.reconnectTimer) return
    this.stopHeartbeat()
    this.reconnectTimer = setInterval(async () => {
      if (this.destroyed) {
        this.stopReconnectLoop()
        return
      }
      await this.connect()
    }, RECONNECT_INTERVAL_MS)
    if (this.reconnectTimer && typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) {
      (this.reconnectTimer as NodeJS.Timeout).unref()
    }
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function getProjectName(directory: string): string {
  const parts = directory.split("/")
  return parts[parts.length - 1] || "Unknown Project"
}

function getFileName(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] || filePath
}

// ─── Utility: Non-blocking RPC update ───────────────────────────────────────
// Prevents Discord RPC from blocking tool execution
function fireAndForget<T>(promise: Promise<T>): void {
  promise.catch(() => {}) // Silently ignore errors
}

// ─── Plugin Entry ───────────────────────────────────────────────────────────
export const DiscordRichPresencePlugin: Plugin = async ({ directory }) => {
  const projectName = getProjectName(directory)

  if (!CLIENT_ID) {
    console.warn(
      "[discord-rpc] No client ID configured. Set DISCORD_RPC_CLIENT_ID env var."
    )
    return {}
  }

  const presence = new PresenceManager(projectName)

  // Connect and set initial presence (fire-and-forget)
  fireAndForget(presence.connect().then(() => 
    presence.update("Idle — waiting for input")
  ))

  // Cleanup on process exit
  process.on("SIGINT", () => { presence.destroySync() })
  process.on("SIGTERM", () => { presence.destroySync() })
  process.on("exit", () => { presence.destroySync() })

  return {
    // ── Session & general events ──────────────────────────────────────────
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created":
            presence.resetSession()
            fireAndForget(presence.update("New session started"))
            break

          case "session.updated":
            fireAndForget(presence.update("Thinking...", presence.statsLine()))
            break

          case "session.idle":
            fireAndForget(presence.update("Idle — waiting for input", presence.statsLine()))
            break

          case "session.error":
            fireAndForget(presence.update("Handling an error"))
            break

          case "session.compacted":
            fireAndForget(presence.update("Context compacted", presence.statsLine()))
            break

          case "session.deleted":
            fireAndForget(presence.clear())
            break

          case "session.diff":
            fireAndForget(presence.update("Reviewing diff"))
            break

          case "session.status":
            fireAndForget(presence.update("Processing...", presence.statsLine()))
            break

          case "file.edited":
            presence.filesEdited++
            fireAndForget(presence.update("File changed", presence.statsLine()))
            break

          case "file.watcher.updated":
            fireAndForget(presence.update("Detected external file change"))
            break

          case "message.updated":
          case "message.part.updated":
            fireAndForget(presence.update("Generating response...", presence.statsLine()))
            break

          case "permission.asked":
            fireAndForget(presence.update("Waiting for permission"))
            break

          case "permission.replied":
            fireAndForget(presence.update("Permission granted — continuing"))
            break

          case "command.executed":
            {
              const cmd = (event as any).properties?.command ?? ""
              const cmdStatus = COMMAND_STATUS[cmd] ?? `Running /${cmd}`
              fireAndForget(presence.update(cmdStatus))
            }
            break

          case "lsp.client.diagnostics":
            fireAndForget(presence.update("Reviewing diagnostics (LSP)"))
            break

          case "lsp.updated":
            fireAndForget(presence.update("LSP server updated"))
            break

          case "todo.updated":
            fireAndForget(presence.update("Managing tasks", presence.statsLine()))
            break

          default:
            break
        }
      } catch {
        // Silently ignore errors to prevent breaking event handling
      }
    },

    // ── Tool hooks ────────────────────────────────────────────────────────
    // CRITICAL: These hooks must NEVER block or throw - they run on every tool execution
    "tool.execute.before": async (input, _output) => {
      try {
        const toolName = input.tool

        if (toolName === "bash") presence.commandsRun++
        if (toolName === "edit" || toolName === "write" || toolName === "patch") presence.filesEdited++

        let status = TOOL_STATUS[toolName]

        if (!status && toolName.includes("_")) {
          const parts = toolName.split("_")
          const server = parts[0]
          const tool = parts.slice(1).join("_")
          status = `Using ${server}: ${tool}`
        }

        if (!status) {
          status = `Using tool: ${toolName}`
        }

        let extra = presence.statsLine()
        const args = (input as any).args ?? {}

        if (toolName === "bash" && args.command) {
          const cmd = String(args.command)
          extra = `$ ${cmd.length > 40 ? cmd.substring(0, 40) + "..." : cmd}`
        } else if ((toolName === "edit" || toolName === "write" || toolName === "read") && args.filePath) {
          extra = getFileName(args.filePath)
        } else if (toolName === "grep" && args.pattern) {
          extra = `/${args.pattern}/`
        } else if (toolName === "glob" && args.pattern) {
          extra = args.pattern
        } else if (toolName === "webfetch" && args.url) {
          try { extra = new URL(String(args.url)).hostname } catch { extra = String(args.url).substring(0, 40) }
        } else if (toolName === "websearch" && args.query) {
          extra = String(args.query).substring(0, 50)
        }

        // Fire-and-forget: never block tool execution
        fireAndForget(presence.update(status, extra || undefined))
      } catch {
        // Silently ignore errors
      }
    },

    "tool.execute.after": async (_input, _output) => {
      // Fire-and-forget: never block tool execution
      fireAndForget(presence.update("Thinking...", presence.statsLine()))
    },

    "file.edited": async () => {
      presence.filesEdited++
      fireAndForget(presence.update("Editing code", presence.statsLine()))
    },
  }
}
