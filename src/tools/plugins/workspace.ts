/**
 * Persistent Workspace Plugin
 *
 * Gives a bot a durable, freely-organizable filesystem; automatically archives
 * Discord image/text attachments into an inbox; and optionally exposes a
 * non-interactive shell. File tools are confined to the configured root and
 * reject symlinks. The shell is intentionally opt-in because cwd is not an OS
 * sandbox: deployments must use a dedicated container/chroot for isolation.
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { spawn } from 'child_process'
import type {
  ContextInjection,
  IncomingAttachment,
  PluginContext,
  PluginStateContext,
  PluginTool,
  ToolPlugin,
} from './types.js'
import type { DiscordContext } from '../../types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger({ plugin: 'workspace' })

const DEFAULT_MAX_READ_BYTES = 128 * 1024
const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024
const DEFAULT_MAX_INBOX_BYTES = 25 * 1024 * 1024
const DEFAULT_SHELL_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_CHARS = 64_000
const inboxIndexWriteQueues = new Map<string, Promise<void>>()

interface WorkspaceConfig {
  root?: string
  capture_attachments?: boolean
  capture_all_attachments?: boolean
  capture_bot_attachments?: boolean
  max_inbox_file_bytes?: number
  max_inbox_items_per_activation?: number
  max_read_bytes?: number
  max_write_bytes?: number
  max_list_entries?: number
  inject_into_context?: boolean
  allow_shell?: boolean
  shell?: string
  shell_args?: string[]
  shell_timeout_ms?: number
  shell_max_output_chars?: number
  shell_env?: Record<string, string>
}

interface ResolvedWorkspaceConfig {
  rootSetting: string
  captureAttachments: boolean
  captureAllAttachments: boolean
  captureBotAttachments: boolean
  maxInboxBytes: number
  maxInboxItemsPerActivation: number
  maxReadBytes: number
  maxWriteBytes: number
  maxListEntries: number
  injectIntoContext: boolean
  allowShell: boolean
  shell: string
  shellArgs: string[]
  shellTimeoutMs: number
  shellMaxOutputChars: number
  shellEnv: Record<string, string>
}

interface InboxIndexEntry {
  attachmentId: string
  messageId: string
  author: string
  filename: string
  relativePath: string
  contentType?: string
  size: number
  capturedAt: string
  originalDownloaded: boolean
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function safeName(value: string, fallback: string, maxLength: number = 120): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
    .replace(/^\.+$/, '_')
    .trim()
  return (cleaned || fallback).slice(0, maxLength)
}

function pluginConfig(context: PluginContext): WorkspaceConfig {
  const stateConfig = (context as PluginStateContext).pluginConfig
  return (stateConfig || context.config?.plugin_config?.workspace || {}) as WorkspaceConfig
}

function resolveConfig(context: PluginContext): ResolvedWorkspaceConfig {
  const config = pluginConfig(context)
  const botDirectory = safeName(context.botId, 'bot', 80)
  const rootSetting = (typeof config.root === 'string' && config.root.trim() ? config.root : undefined)
    || process.env.CHAPTERX_WORKSPACE_ROOT
    || join(process.cwd(), 'workspace', botDirectory)
  const shellEnv = Object.fromEntries(
    Object.entries(config.shell_env || {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )

  return {
    rootSetting,
    captureAttachments: config.capture_attachments !== false,
    captureAllAttachments: config.capture_all_attachments === true,
    captureBotAttachments: config.capture_bot_attachments === true,
    maxInboxBytes: clampInteger(config.max_inbox_file_bytes, DEFAULT_MAX_INBOX_BYTES, 1024, 100 * 1024 * 1024),
    maxInboxItemsPerActivation: clampInteger(config.max_inbox_items_per_activation, 8, 1, 100),
    maxReadBytes: clampInteger(config.max_read_bytes, DEFAULT_MAX_READ_BYTES, 1024, 4 * 1024 * 1024),
    maxWriteBytes: clampInteger(config.max_write_bytes, DEFAULT_MAX_WRITE_BYTES, 1024, 16 * 1024 * 1024),
    maxListEntries: clampInteger(config.max_list_entries, 300, 20, 2000),
    injectIntoContext: config.inject_into_context !== false,
    allowShell: config.allow_shell === true,
    shell: typeof config.shell === 'string' && config.shell ? config.shell : '/bin/sh',
    shellArgs: Array.isArray(config.shell_args) && config.shell_args.every(arg => typeof arg === 'string')
      ? config.shell_args
      : ['-lc'],
    shellTimeoutMs: clampInteger(config.shell_timeout_ms, DEFAULT_SHELL_TIMEOUT_MS, 500, 120_000),
    shellMaxOutputChars: clampInteger(config.shell_max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 1000, 1_000_000),
    shellEnv,
  }
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

async function getWorkspaceRoot(context: PluginContext): Promise<string> {
  const configured = expandHome(resolveConfig(context).rootSetting)
  const root = isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  await fs.mkdir(root, { recursive: true })
  const canonicalRoot = await fs.realpath(root)
  for (const name of ['inbox', '.trash', '.tmp']) {
    const directory = join(canonicalRoot, name)
    try {
      const stat = await fs.lstat(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Reserved workspace path must be a real directory: ${name}`)
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      await fs.mkdir(directory)
    }
  }
  return canonicalRoot
}

async function assertNoSymlinks(root: string, candidate: string): Promise<void> {
  const rel = relative(root, candidate)
  if (!rel) return

  let current = root
  for (const component of rel.split(sep)) {
    current = join(current, component)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in workspace paths: ${relative(root, current)}`)
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return
      throw error
    }
  }
}

async function resolveWorkspacePath(root: string, requested: string | undefined): Promise<string> {
  const userPath = requested?.trim() || '.'
  if (isAbsolute(userPath)) {
    throw new Error('Workspace paths must be relative')
  }

  const candidate = resolve(root, userPath)
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path escapes the workspace root')
  }

  await assertNoSymlinks(root, candidate)
  return candidate
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

async function renderTree(root: string, start: string, depth: number, maxEntries: number): Promise<string> {
  const lines: string[] = []
  let seen = 0

  const walk = async (directory: string, prefix: string, remainingDepth: number): Promise<void> => {
    if (seen >= maxEntries) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (seen++ >= maxEntries) break
      const fullPath = join(directory, entry.name)
      const displayPath = `${prefix}${entry.name}`
      if (entry.isSymbolicLink()) {
        lines.push(`${displayPath} -> [symlink blocked]`)
      } else if (entry.isDirectory()) {
        lines.push(`${displayPath}/`)
        if (remainingDepth > 0) await walk(fullPath, `${displayPath}/`, remainingDepth - 1)
      } else {
        const stat = await fs.stat(fullPath)
        lines.push(`${displayPath} (${humanBytes(stat.size)})`)
      }
    }
  }

  const stat = await fs.stat(start)
  if (!stat.isDirectory()) {
    return `${relative(root, start) || '.'} (${humanBytes(stat.size)})`
  }

  await walk(start, '', depth)
  if (seen >= maxEntries) lines.push(`… listing capped at ${maxEntries} entries`)
  return lines.length > 0 ? lines.join('\n') : '(empty directory)'
}

function textAttachment(attachment: IncomingAttachment): boolean {
  const type = attachment.contentType?.toLowerCase() || ''
  if (type.startsWith('text/') || [
    'application/json', 'application/xml', 'application/javascript',
    'application/typescript', 'application/x-yaml', 'application/yaml',
    'application/x-sh', 'application/x-python',
  ].some(prefix => type.startsWith(prefix))) return true

  const lower = attachment.filename.toLowerCase()
  return [
    '.txt', '.md', '.markdown', '.rst', '.py', '.js', '.ts', '.jsx', '.tsx',
    '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml', '.xml', '.html',
    '.htm', '.css', '.scss', '.sass', '.less', '.sh', '.bash', '.zsh',
    '.fish', '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx', '.java', '.rs',
    '.go', '.rb', '.php', '.sql', '.graphql', '.gql', '.lua', '.perl',
    '.pl', '.r', '.swift', '.kt', '.kts', '.scala', '.vim', '.el', '.lisp',
    '.clj', '.cljs', '.ini', '.cfg', '.conf', '.config', '.log', '.csv', '.tsv',
  ].some(extension => lower.endsWith(extension))
}

function shouldCapture(attachment: IncomingAttachment, config: ResolvedWorkspaceConfig): boolean {
  if (attachment.authorBot && !config.captureBotAttachments) return false
  if (config.captureAllAttachments) return true
  return attachment.contentType?.startsWith('image/') === true || textAttachment(attachment)
}

async function downloadAttachment(url: string, maxBytes: number): Promise<Buffer> {
  if (!url) throw new Error('Attachment URL is unavailable')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)

  try {
    const response = await fetch(url, { signal: abort.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Attachment exceeds inbox limit (${humanBytes(contentLength)} > ${humanBytes(maxBytes)})`)
    }

    if (!response.body) return Buffer.from(await response.arrayBuffer())
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body as any) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) throw new Error(`Attachment exceeds inbox limit (${humanBytes(maxBytes)})`)
      chunks.push(buffer)
    }
    return Buffer.concat(chunks, total)
  } finally {
    clearTimeout(timer)
  }
}

async function atomicWrite(path: string, data: Buffer | string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function appendInboxIndex(root: string, entry: InboxIndexEntry): Promise<void> {
  const indexPath = join(root, 'inbox', 'index.jsonl')
  const previous = inboxIndexWriteQueues.get(indexPath) || Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(() => fs.appendFile(indexPath, `${JSON.stringify(entry)}\n`))
  inboxIndexWriteQueues.set(indexPath, current)
  try {
    await current
  } finally {
    if (inboxIndexWriteQueues.get(indexPath) === current) {
      inboxIndexWriteQueues.delete(indexPath)
    }
  }
}

async function captureAttachment(
  root: string,
  attachment: IncomingAttachment,
  config: ResolvedWorkspaceConfig,
): Promise<InboxIndexEntry | null> {
  if (!shouldCapture(attachment, config)) return null
  if (attachment.size > config.maxInboxBytes) {
    logger.warn({ attachmentId: attachment.id, size: attachment.size }, 'Skipping oversized workspace inbox item')
    return null
  }

  const validTimestamp = !Number.isNaN(attachment.timestamp.getTime())
    ? attachment.timestamp
    : new Date()
  const day = Number.isNaN(attachment.timestamp.getTime())
    ? new Date().toISOString().slice(0, 10)
    : attachment.timestamp.toISOString().slice(0, 10)
  const messageDirectory = join(
    root,
    'inbox',
    day,
    safeName(attachment.messageId, 'message', 80),
  )
  const storedName = `${safeName(attachment.id, 'attachment', 80)}-${safeName(attachment.filename, 'attachment.bin')}`
  const destination = join(messageDirectory, storedName)

  try {
    await fs.access(destination)
    return null // Already captured.
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
  }

  await fs.mkdir(messageDirectory, { recursive: true })

  let data: Buffer
  let originalDownloaded = false
  if (attachment.data && !attachment.truncated && attachment.data.length === attachment.size) {
    // The connector already downloaded an exact-size copy while assembling
    // context. Reuse it instead of hitting Discord's CDN twice per activation.
    data = attachment.data
  } else {
    try {
      data = await downloadAttachment(attachment.url, config.maxInboxBytes)
      originalDownloaded = true
    } catch (error) {
      // Context fetch may still hold a safe copy when a Discord CDN URL expires.
      // Prefer continuity over losing the item, while recording the distinction.
      if (!attachment.data || attachment.truncated) throw error
      data = attachment.data
    }
  }

  if (data.length > config.maxInboxBytes) {
    throw new Error(`Attachment exceeds inbox limit (${humanBytes(config.maxInboxBytes)})`)
  }

  await atomicWrite(destination, data)
  const entry: InboxIndexEntry = {
    attachmentId: attachment.id,
    messageId: attachment.messageId,
    author: attachment.authorName,
    filename: attachment.filename,
    relativePath: relative(root, destination),
    contentType: attachment.contentType,
    size: data.length,
    capturedAt: new Date().toISOString(),
    originalDownloaded,
  }
  await atomicWrite(`${destination}.metadata.json`, JSON.stringify({
    ...entry,
    sourceUrl: attachment.url,
    channelId: attachment.channelId,
    guildId: attachment.guildId,
    authorId: attachment.authorId,
    messageTimestamp: validTimestamp.toISOString(),
  }, null, 2))
  await appendInboxIndex(root, entry)
  return entry
}

async function recentInboxEntries(root: string, limit: number = 8): Promise<InboxIndexEntry[]> {
  const indexPath = join(root, 'inbox', 'index.jsonl')
  try {
    const stat = await fs.stat(indexPath)
    const bytes = Math.min(stat.size, 128 * 1024)
    const handle = await fs.open(indexPath, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      await handle.read(buffer, 0, bytes, stat.size - bytes)
      return buffer.toString('utf-8')
        .split('\n')
        .filter(Boolean)
        .slice(stat.size > bytes ? 1 : 0)
        .flatMap(line => {
          try { return [JSON.parse(line) as InboxIndexEntry] } catch { return [] }
        })
        .slice(-limit)
        .reverse()
    } finally {
      await handle.close()
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Build archive candidates from the already-fetched Discord context. */
export function collectIncomingAttachments(discordContext: DiscordContext): IncomingAttachment[] {
  const imagesByUrl = new Map(discordContext.images.map(image => [image.url, image]))
  const documentsByKey = new Map(discordContext.documents.map(document => [
    `${document.messageId}:${document.url}`,
    document,
  ]))

  return discordContext.messages.flatMap(message => message.attachments.map(attachment => {
    const image = imagesByUrl.get(attachment.url)
    const document = documentsByKey.get(`${message.id}:${attachment.url}`)
    const data = document && !document.truncated
      ? Buffer.from(document.text, 'utf-8')
      : image?.data

    return {
      ...attachment,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      authorName: message.author.displayName || message.author.username,
      authorBot: message.author.bot,
      timestamp: message.timestamp,
      data,
      truncated: document?.truncated,
    }
  }))
}

function tool(name: string, description: string, inputSchema: PluginTool['inputSchema'], handler: PluginTool['handler']): PluginTool {
  return { name, description, inputSchema, handler }
}

const tools: PluginTool[] = [
  tool(
    'workspace_list',
    'List files in your persistent workspace as a compact tree. Paths are relative to the workspace root.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory or file to list (default: .)' },
        depth: { type: 'number', description: 'Recursive directory depth, 0-5 (default: 2)' },
      },
    },
    async (input: { path?: string; depth?: number }, context) => {
      try {
        const root = await getWorkspaceRoot(context)
        const target = await resolveWorkspacePath(root, input.path)
        const depth = clampInteger(input.depth, 2, 0, 5)
        return await renderTree(root, target, depth, resolveConfig(context).maxListEntries)
      } catch (error: any) {
        return `Error listing workspace: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_read',
    'Read a text file from your persistent workspace. Paths are relative; binary files return metadata instead of raw bytes.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to read' },
        offset: { type: 'number', description: 'Byte offset to begin reading (default: 0)' },
        max_bytes: { type: 'number', description: 'Maximum bytes to return, capped by administrator configuration' },
      },
      required: ['path'],
    },
    async (input: { path: string; offset?: number; max_bytes?: number }, context) => {
      try {
        const config = resolveConfig(context)
        const root = await getWorkspaceRoot(context)
        const target = await resolveWorkspacePath(root, input.path)
        const stat = await fs.stat(target)
        if (!stat.isFile()) return `Error reading workspace: ${input.path} is not a regular file`

        const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER)
        const requested = clampInteger(input.max_bytes, config.maxReadBytes, 1, config.maxReadBytes)
        const length = Math.max(0, Math.min(requested, stat.size - offset))
        const buffer = Buffer.alloc(length)
        const handle = await fs.open(target, 'r')
        try { await handle.read(buffer, 0, length, offset) } finally { await handle.close() }

        if (buffer.subarray(0, 8192).includes(0)) {
          return `${input.path} is binary (${humanBytes(stat.size)}); use workspace_shell when enabled, or a separately enabled upload tool, to inspect/share it.`
        }
        const end = offset + length
        const continuation = end < stat.size ? `\n\n[bytes ${offset}-${end} of ${stat.size}; continue with offset ${end}]` : ''
        return buffer.toString('utf-8') + continuation
      } catch (error: any) {
        return `Error reading workspace: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_write',
    'Create, overwrite, or append to a UTF-8 text file in your persistent workspace. Parent directories are created automatically.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative destination path' },
        content: { type: 'string', description: 'UTF-8 text to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default: overwrite)' },
      },
      required: ['path', 'content'],
    },
    async (input: { path: string; content: string; mode?: 'overwrite' | 'append' }, context) => {
      try {
        const config = resolveConfig(context)
        const bytes = Buffer.byteLength(input.content, 'utf-8')
        if (bytes > config.maxWriteBytes) {
          return `Error writing workspace: content exceeds ${humanBytes(config.maxWriteBytes)} per-call limit`
        }
        const root = await getWorkspaceRoot(context)
        const target = await resolveWorkspacePath(root, input.path)
        if (target === root) return 'Error writing workspace: destination must be a file path'
        await fs.mkdir(dirname(target), { recursive: true })
        if (input.mode === 'append') await fs.appendFile(target, input.content, 'utf-8')
        else await atomicWrite(target, input.content)
        return `Wrote ${humanBytes(bytes)} to ${relative(root, target)}`
      } catch (error: any) {
        return `Error writing workspace: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_move',
    'Move or rename a workspace file/directory. The destination must not already exist.',
    {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Existing relative path' },
        to: { type: 'string', description: 'New relative path' },
      },
      required: ['from', 'to'],
    },
    async (input: { from: string; to: string }, context) => {
      try {
        const root = await getWorkspaceRoot(context)
        const source = await resolveWorkspacePath(root, input.from)
        const destination = await resolveWorkspacePath(root, input.to)
        if (source === root || destination === root) return 'Error moving workspace item: root cannot be moved or replaced'
        await fs.access(destination).then(
          () => { throw new Error('Destination already exists') },
          (error: any) => { if (error.code !== 'ENOENT') throw error },
        )
        await fs.mkdir(dirname(destination), { recursive: true })
        await fs.rename(source, destination)
        return `Moved ${relative(root, source)} to ${relative(root, destination)}`
      } catch (error: any) {
        return `Error moving workspace item: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_mkdir',
    'Create an empty directory (and any missing parents) in your persistent workspace.',
    {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path to create' } },
      required: ['path'],
    },
    async (input: { path: string }, context) => {
      try {
        const root = await getWorkspaceRoot(context)
        const destination = await resolveWorkspacePath(root, input.path)
        if (destination === root) return 'Workspace root already exists'
        await fs.mkdir(destination, { recursive: true })
        return `Created directory ${relative(root, destination)}`
      } catch (error: any) {
        return `Error creating workspace directory: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_trash',
    'Move a file or directory into the recoverable .trash area. This does not permanently delete it.',
    {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path to move to trash' } },
      required: ['path'],
    },
    async (input: { path: string }, context) => {
      try {
        const root = await getWorkspaceRoot(context)
        const source = await resolveWorkspacePath(root, input.path)
        const rel = relative(root, source)
        if (!rel || rel === '.trash' || rel.startsWith(`.trash${sep}`)) {
          return 'Error trashing workspace item: root and .trash cannot be trashed'
        }
        const destination = join(
          root,
          '.trash',
          `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}-${basename(source)}`,
        )
        await fs.rename(source, destination)
        return `Moved ${rel} to ${relative(root, destination)} (recoverable)`
      } catch (error: any) {
        return `Error trashing workspace item: ${error.message}`
      }
    },
  ),
  tool(
    'workspace_shell',
    'Run a non-interactive shell command with the persistent workspace as cwd. Disabled unless allow_shell is true. The deployment container/chroot, not cwd, is the security boundary.',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        cwd: { type: 'string', description: 'Optional relative working directory within the workspace' },
        timeout_ms: { type: 'number', description: 'Optional shorter timeout in milliseconds' },
      },
      required: ['command'],
    },
    async (input: { command: string; cwd?: string; timeout_ms?: number }, context) => {
      const config = resolveConfig(context)
      if (!config.allowShell) {
        return 'Shell access is disabled. An administrator can opt in with plugin_config.workspace.allow_shell: true after container/chroot isolation is in place.'
      }
      if (!input.command?.trim()) return 'Error running workspace command: command is empty'
      if (input.command.length > 20_000) return 'Error running workspace command: command is too long'

      try {
        const root = await getWorkspaceRoot(context)
        const cwd = await resolveWorkspacePath(root, input.cwd)
        const stat = await fs.stat(cwd)
        if (!stat.isDirectory()) return `Error running workspace command: cwd is not a directory: ${input.cwd}`
        const timeoutMs = clampInteger(input.timeout_ms, config.shellTimeoutMs, 100, config.shellTimeoutMs)
        await fs.mkdir(join(root, '.tmp'), { recursive: true })

        const environment: NodeJS.ProcessEnv = {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG || 'C.UTF-8',
          LC_ALL: process.env.LC_ALL || 'C.UTF-8',
          HOME: root,
          TMPDIR: join(root, '.tmp'),
          CHAPTERX_WORKSPACE: root,
          ...config.shellEnv,
        }

        return await new Promise<string>((resolveResult) => {
          const child = spawn(config.shell, [...config.shellArgs, input.command], {
            cwd,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          })
          let stdout = ''
          let stderr = ''
          let captured = 0
          let truncated = false
          let timedOut = false
          let settled = false
          let forceTimer: NodeJS.Timeout | undefined

          const terminate = (signal: NodeJS.Signals) => {
            try {
              if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
              else child.kill(signal)
            } catch {
              // Process may already have exited between the timeout and signal.
            }
          }

          const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
            const text = chunk.toString('utf-8')
            const remaining = config.shellMaxOutputChars - captured
            if (remaining <= 0) {
              truncated = true
              return
            }
            const accepted = text.slice(0, remaining)
            captured += accepted.length
            if (accepted.length < text.length) truncated = true
            if (target === 'stdout') stdout += accepted
            else stderr += accepted
          }

          child.stdout.on('data', chunk => capture('stdout', Buffer.from(chunk)))
          child.stderr.on('data', chunk => capture('stderr', Buffer.from(chunk)))

          const timer = setTimeout(() => {
            timedOut = true
            terminate('SIGTERM')
            forceTimer = setTimeout(() => terminate('SIGKILL'), 1000)
            forceTimer.unref()
          }, timeoutMs)

          child.on('error', error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (forceTimer) clearTimeout(forceTimer)
            resolveResult(`Error running workspace command: ${error.message}`)
          })
          child.on('close', (code, signal) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (forceTimer) clearTimeout(forceTimer)
            const header = timedOut
              ? `Command timed out after ${timeoutMs}ms`
              : `Command exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
            const sections = [header]
            if (stdout) sections.push(`stdout:\n${stdout}`)
            if (stderr) sections.push(`stderr:\n${stderr}`)
            if (truncated) sections.push(`[output truncated at ${config.shellMaxOutputChars} characters]`)
            resolveResult(sections.join('\n\n'))
          })
        })
      } catch (error: any) {
        return `Error running workspace command: ${error.message}`
      }
    },
  ),
]

const plugin: ToolPlugin = {
  name: 'workspace',
  description: 'Persistent personal filesystem, attachment inbox, and optional non-interactive shell',
  tools,

  onActivation: async (context) => {
    const config = resolveConfig(context)
    const root = await getWorkspaceRoot(context)
    if (!config.captureAttachments) return

    const candidates = (context.incomingAttachments || [])
      .filter(attachment => shouldCapture(attachment, config))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Existing recent items do not consume the per-activation budget, allowing
    // older context attachments to drain into the inbox over later activations.
    const pending: IncomingAttachment[] = []
    for (const attachment of candidates) {
      const validTimestamp = !Number.isNaN(attachment.timestamp.getTime())
        ? attachment.timestamp
        : new Date()
      const destination = join(
        root,
        'inbox',
        validTimestamp.toISOString().slice(0, 10),
        safeName(attachment.messageId, 'message', 80),
        `${safeName(attachment.id, 'attachment', 80)}-${safeName(attachment.filename, 'attachment.bin')}`,
      )
      try {
        await fs.access(destination)
        continue
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error
      }
      pending.push(attachment)
      if (pending.length >= config.maxInboxItemsPerActivation) break
    }

    // Bound simultaneous downloads so a burst of large files cannot multiply
    // memory use by the entire activation budget.
    for (let index = 0; index < pending.length; index += 4) {
      const batch = pending.slice(index, index + 4)
      await Promise.all(batch.map(async attachment => {
        try {
          const captured = await captureAttachment(root, attachment, config)
          if (captured) {
            logger.info({
              attachmentId: attachment.id,
              messageId: attachment.messageId,
              relativePath: captured.relativePath,
            }, 'Captured Discord attachment in workspace inbox')
          }
        } catch (error) {
          logger.warn({ error, attachmentId: attachment.id, messageId: attachment.messageId }, 'Failed to capture workspace inbox item')
        }
      }))
    }
  },

  getContextInjections: async (context): Promise<ContextInjection[]> => {
    const config = resolveConfig(context)
    if (!config.injectIntoContext) return []
    const root = await getWorkspaceRoot(context)
    const recent = await recentInboxEntries(root)
    const lines = [
      '## Persistent workspace',
      '',
      'This is your durable personal filesystem. Its organization is yours; files remain across conversation windows and restarts.',
      `Workspace root: ${root}`,
      'New Discord image/text attachments are copied idempotently into inbox/. Removed items go to recoverable .trash/.',
      `Shell: ${config.allowShell ? `enabled via ${config.shell}` : 'disabled (filesystem tools remain available)'}.`,
    ]
    if (recent.length > 0) {
      lines.push('', 'Recent inbox arrivals:')
      for (const entry of recent) {
        lines.push(`- ${entry.relativePath} — ${entry.author}, ${humanBytes(entry.size)}`)
      }
    }
    lines.push('', 'Use workspace_list/read/write/mkdir/move/trash to tend this space; use workspace_shell when enabled.')

    return [{
      id: 'workspace-status',
      content: lines.join('\n'),
      targetDepth: 8,
      priority: 95,
    }]
  },
}

export default plugin
