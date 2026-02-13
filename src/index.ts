import type { Plugin } from "@opencode-ai/plugin"
import { Client } from "@xhayper/discord-rpc"

/**
 * OpenCode Discord Rich Presence Plugin
 *
 * Shows "Playing OpenCode" on your Discord profile with the current
 * project name and a detailed real-time status of what the agent is doing.
 *
 * Tracks:
 *   - All 15+ built-in tools (bash, edit, write, read, grep, glob, list,
 *     patch, webfetch, websearch, todowrite, todoread, lsp, skill, question)
 *   - Session lifecycle (created, idle, error, compacted, deleted)
 *   - File edits and file watcher updates
 *   - Agent modes (Build, Plan, Explore, General)
 *   - Permission prompts
 *   - Slash commands (/init, /undo, /redo, /share, /compact, etc.)
 *   - Message activity
 *
 * Prerequisites:
 *   1. Create a Discord Application at https://discord.com/developers/applications
 *   2. Set the application name to "OpenCode" (this becomes the "Playing ..." text)
 *   3. Upload a Rich Presence art asset named "opencode_logo"
 *   4. Set the DISCORD_RPC_CLIENT_ID env var to your application's Client ID
 *      or hardcode it below.
 */

// ─── Configuration ──────────────────────────────────────────────────────────
const CLIENT_ID = process.env.DISCORD_RPC_CLIENT_ID ?? "DISCORD_APP_ID_PLACEHOLDER"
const LARGE_IMAGE_KEY = "opencode_logo"
const LARGE_IMAGE_TEXT = "OpenCode - AI Coding Agent"

// ─── State ──────────────────────────────────────────────────────────────────
let rpcClient: Client | null = null
let sessionStartTimestamp: Date | null = null
let connected = false
let lastStatus = ""
let filesEdited = 0
let commandsRun = 0

// ─── Tool → Status mapping ─────────────────────────────────────────────────
// Maps every built-in OpenCode tool to a human-readable status string.
const TOOL_STATUS: Record<string, string> = {
  // File mutation tools
  bash: "Running shell commands",
  edit: "Editing code",
  write: "Writing files",
  patch: "Applying patches",

  // File reading tools
  read: "Reading files",
  grep: "Searching codebase",
  glob: "Finding files by pattern",
  list: "Browsing directories",

  // Intelligence tools
  lsp: "Querying LSP (code intelligence)",
  skill: "Loading agent skill",

  // Web tools
  webfetch: "Fetching web content",
  websearch: "Searching the web",

  // Task management tools
  todowrite: "Updating task list",
  todoread: "Reviewing tasks",

  // Interaction tools
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

// ─── RPC Connection ─────────────────────────────────────────────────────────
async function connectRPC(): Promise<boolean> {
  if (connected && rpcClient) return true

  try {
    rpcClient = new Client({ clientId: CLIENT_ID })
    await rpcClient.login()
    connected = true
    return true
  } catch (err) {
    console.error("[discord-rpc] Failed to connect:", err)
    connected = false
    rpcClient = null
    return false
  }
}

async function updatePresence(
  projectName: string,
  state: string,
  extraDetails?: string
): Promise<void> {
  if (!rpcClient || !connected) {
    const ok = await connectRPC()
    if (!ok) return
  }

  // Avoid spamming Discord with duplicate updates
  if (state === lastStatus && !extraDetails) return
  lastStatus = state

  const details = extraDetails
    ? `${projectName} · ${extraDetails}`
    : `Working on ${projectName}`

  try {
    await rpcClient!.user?.setActivity({
      details,
      state,
      startTimestamp: sessionStartTimestamp ?? new Date(),
      largeImageKey: LARGE_IMAGE_KEY,
      largeImageText: LARGE_IMAGE_TEXT,
      instance: false,
    })
  } catch (err) {
    console.error("[discord-rpc] Failed to set activity:", err)
    connected = false
  }
}

async function clearPresence(): Promise<void> {
  if (!rpcClient || !connected) return
  try {
    await rpcClient.user?.clearActivity()
  } catch {
    // ignore
  }
}

async function destroyRPC(): Promise<void> {
  if (!rpcClient) return
  try {
    await clearPresence()
    await rpcClient.destroy()
  } catch {
    // ignore
  } finally {
    rpcClient = null
    connected = false
    sessionStartTimestamp = null
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

function statsLine(): string {
  const parts: string[] = []
  if (filesEdited > 0) parts.push(`${filesEdited} file${filesEdited > 1 ? "s" : ""} edited`)
  if (commandsRun > 0) parts.push(`${commandsRun} cmd${commandsRun > 1 ? "s" : ""} run`)
  return parts.length > 0 ? parts.join(" · ") : ""
}

// ─── Plugin Entry ───────────────────────────────────────────────────────────
export const DiscordRichPresencePlugin: Plugin = async ({ directory }) => {
  const projectName = getProjectName(directory)

  if (CLIENT_ID === "REPLACE_WITH_YOUR_CLIENT_ID") {
    console.warn(
      "[discord-rpc] No client ID configured. Set DISCORD_RPC_CLIENT_ID env var " +
        "or replace the default in the plugin source."
    )
    return {}
  }

  // Connect and set initial presence
  sessionStartTimestamp = new Date()
  filesEdited = 0
  commandsRun = 0
  const ok = await connectRPC()
  if (ok) {
    await updatePresence(projectName, "Starting session")
  }

  // Cleanup on process exit
  const cleanup = () => { destroyRPC() }
  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  return {
    // ── Session & general events ──────────────────────────────────────────
    event: async ({ event }) => {
      switch (event.type) {
        // Session lifecycle
        case "session.created":
          sessionStartTimestamp = new Date()
          filesEdited = 0
          commandsRun = 0
          await updatePresence(projectName, "New session started")
          break

        case "session.updated":
          await updatePresence(projectName, "Thinking...", statsLine())
          break

        case "session.idle":
          await updatePresence(projectName, "Idle — waiting for input", statsLine())
          break

        case "session.error":
          await updatePresence(projectName, "Handling an error")
          break

        case "session.compacted":
          await updatePresence(projectName, "Context compacted", statsLine())
          break

        case "session.deleted":
          await clearPresence()
          break

        case "session.diff":
          await updatePresence(projectName, "Reviewing diff")
          break

        case "session.status":
          await updatePresence(projectName, "Processing...", statsLine())
          break

        // File events
        case "file.edited":
          filesEdited++
          await updatePresence(projectName, "File changed", statsLine())
          break

        case "file.watcher.updated":
          await updatePresence(projectName, "Detected external file change")
          break

        // Message events — the agent is actively responding
        case "message.updated":
        case "message.part.updated":
          await updatePresence(projectName, "Generating response...", statsLine())
          break

        // Permission events
        case "permission.asked":
          await updatePresence(projectName, "Waiting for permission")
          break

        case "permission.replied":
          await updatePresence(projectName, "Permission granted — continuing")
          break

        // Command events (slash commands like /init, /undo, /redo, etc.)
        case "command.executed":
          {
            const cmd = (event as any).properties?.command ?? ""
            const cmdStatus = COMMAND_STATUS[cmd] ?? `Running /${cmd}`
            await updatePresence(projectName, cmdStatus)
          }
          break

        // LSP diagnostics
        case "lsp.client.diagnostics":
          await updatePresence(projectName, "Reviewing diagnostics (LSP)")
          break

        case "lsp.updated":
          await updatePresence(projectName, "LSP server updated")
          break

        // Todo events
        case "todo.updated":
          await updatePresence(projectName, "Managing tasks", statsLine())
          break

        default:
          break
      }
    },

    // ── Tool hooks ────────────────────────────────────────────────────────
    "tool.execute.before": async (input, _output) => {
      const toolName = input.tool

      // Track counters
      if (toolName === "bash") commandsRun++
      if (toolName === "edit" || toolName === "write" || toolName === "patch") filesEdited++

      // Build a descriptive status from the tool name
      let status = TOOL_STATUS[toolName]

      // If the tool is from an MCP server (prefixed), show the server name
      if (!status && toolName.includes("_")) {
        const parts = toolName.split("_")
        const server = parts[0]
        const tool = parts.slice(1).join("_")
        status = `Using ${server}: ${tool}`
      }

      // Fallback for unknown / custom tools
      if (!status) {
        status = `Using tool: ${toolName}`
      }

      // Add contextual details for specific tools
      let extra = statsLine()
      const args = (input as any).args ?? {}

      if (toolName === "bash" && args.command) {
        const cmd = String(args.command)
        const shortCmd = cmd.length > 40 ? cmd.substring(0, 40) + "..." : cmd
        extra = `$ ${shortCmd}`
      } else if ((toolName === "edit" || toolName === "write" || toolName === "read") && args.filePath) {
        extra = getFileName(args.filePath)
      } else if (toolName === "grep" && args.pattern) {
        extra = `/${args.pattern}/`
      } else if (toolName === "glob" && args.pattern) {
        extra = args.pattern
      } else if (toolName === "webfetch" && args.url) {
        const url = String(args.url)
        try {
          extra = new URL(url).hostname
        } catch {
          extra = url.substring(0, 40)
        }
      } else if (toolName === "websearch" && args.query) {
        extra = String(args.query).substring(0, 50)
      }

      await updatePresence(projectName, status, extra || undefined)
    },

    "tool.execute.after": async (_input, _output) => {
      // Reset the dedup guard so the next event can update
      lastStatus = ""
      await updatePresence(projectName, "Thinking...", statsLine())
    },

    // ── File edit hook ────────────────────────────────────────────────────
    "file.edited": async () => {
      filesEdited++
      await updatePresence(projectName, "Editing code", statsLine())
    },
  }
}
