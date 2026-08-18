import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import workspacePlugin, { collectIncomingAttachments } from './workspace.js'
import type { IncomingAttachment, PluginContext, PluginStateContext } from './types.js'

function makeContext(root: string, config: Record<string, unknown> = {}): PluginStateContext {
  const pluginConfig = { root, ...config }
  return {
    botId: 'claude46',
    channelId: 'channel-1',
    guildId: 'guild-1',
    currentMessageId: 'message-1',
    config: { plugin_config: { workspace: pluginConfig } },
    pluginConfig,
    configuredScope: 'global',
    contextMessageIds: new Set(),
    messagesSinceId: () => Infinity,
    getState: async () => null,
    setState: async () => {},
    getStateAtMessage: async () => null,
    sendMessage: async () => [],
    pinMessage: async () => {},
    addReaction: async () => {},
  }
}

async function callTool(name: string, input: any, context: PluginContext): Promise<string> {
  const selected = workspacePlugin.tools.find(candidate => candidate.name === name)
  if (!selected) throw new Error(`Missing tool: ${name}`)
  return String(await selected.handler(input, context))
}

describe('workspace plugin filesystem tools', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('supports a durable write/read/list/move/trash workflow', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-test-'))
    const context = makeContext(root)

    expect(await callTool('workspace_write', {
      path: 'garden/first.txt',
      content: 'one',
    }, context)).toContain('garden/first.txt')
    await callTool('workspace_write', {
      path: 'garden/first.txt',
      content: '\ntwo',
      mode: 'append',
    }, context)
    expect(await callTool('workspace_read', { path: 'garden/first.txt' }, context)).toBe('one\ntwo')

    const listing = await callTool('workspace_list', { path: '.', depth: 2 }, context)
    expect(listing).toContain('garden/')
    expect(listing).toContain('garden/first.txt')

    expect(await callTool('workspace_move', {
      from: 'garden/first.txt',
      to: 'archive/kept.txt',
    }, context)).toContain('archive/kept.txt')
    expect(await callTool('workspace_mkdir', { path: 'empty/nested' }, context)).toContain('empty/nested')
    expect((await fs.stat(join(root, 'empty', 'nested'))).isDirectory()).toBe(true)
    expect(await callTool('workspace_trash', { path: 'archive/kept.txt' }, context)).toContain('(recoverable)')

    const trash = await fs.readdir(join(root, '.trash'))
    expect(trash.some(name => name.endsWith('-kept.txt'))).toBe(true)
  })

  it('rejects traversal and symlinks that could escape the workspace', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-test-'))
    const outside = mkdtempSync(join(tmpdir(), 'chapterx-workspace-outside-'))
    const context = makeContext(root)
    try {
      await fs.writeFile(join(outside, 'secret.txt'), 'outside')
      await fs.symlink(outside, join(root, 'escape'))

      expect(await callTool('workspace_read', { path: '../secret.txt' }, context)).toContain('escapes the workspace root')
      expect(await callTool('workspace_read', { path: 'escape/secret.txt' }, context)).toContain('Symbolic links are not allowed')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a reserved inbox path replaced by a symlink', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-test-'))
    const outside = mkdtempSync(join(tmpdir(), 'chapterx-workspace-outside-'))
    try {
      await fs.symlink(outside, join(root, 'inbox'))
      const result = await callTool('workspace_list', { path: '.' }, makeContext(root))
      expect(result).toContain('Reserved workspace path must be a real directory: inbox')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('workspace plugin shell', () => {
  let root: string | undefined

  afterEach(() => {
    delete process.env.CHAPTERX_WORKSPACE_TEST_SECRET
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('is disabled by default', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-shell-'))
    const result = await callTool('workspace_shell', { command: 'echo nope' }, makeContext(root))
    expect(result).toContain('Shell access is disabled')
  })

  it.skipIf(process.platform === 'win32')('runs in the workspace with a scrubbed environment when enabled', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-shell-'))
    process.env.CHAPTERX_WORKSPACE_TEST_SECRET = 'must-not-leak'
    const context = makeContext(root, { allow_shell: true })
    const result = await callTool('workspace_shell', {
      command: 'printf "%s\\n%s\\n%s" "$PWD" "$HOME" "${CHAPTERX_WORKSPACE_TEST_SECRET-unset}"',
    }, context)
    const canonicalRoot = await fs.realpath(root)

    expect(result).toContain('Command exited with code 0')
    expect(result).toContain(`${canonicalRoot}\n${canonicalRoot}\nunset`)
    expect(result).not.toContain('must-not-leak')
  })

  it.skipIf(process.platform === 'win32')('terminates the shell process group at the configured timeout', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-shell-'))
    const context = makeContext(root, { allow_shell: true, shell_timeout_ms: 500 })
    const startedAt = Date.now()
    const result = await callTool('workspace_shell', {
      command: 'sleep 5 & wait',
      timeout_ms: 150,
    }, context)

    expect(result).toContain('Command timed out after 150ms')
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})

describe('workspace attachment inbox', () => {
  let root: string | undefined

  afterEach(() => {
    vi.unstubAllGlobals()
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('collects attachment metadata and cached bytes from Discord context', () => {
    const timestamp = new Date('2026-08-18T12:00:00.000Z')
    const attachments = collectIncomingAttachments({
      guildId: 'guild-1',
      pinnedConfigs: [],
      images: [{ url: 'https://cdn/image.png', data: Buffer.from('png'), mediaType: 'image/png', hash: 'hash' }],
      documents: [{
        messageId: 'message-1',
        url: 'https://cdn/notes.txt',
        filename: 'notes.txt',
        size: 5,
        text: 'hello',
      }],
      messages: [{
        id: 'message-1',
        channelId: 'channel-1',
        guildId: 'guild-1',
        author: { id: 'user-1', username: 'rat', displayName: 'rat', bot: false },
        content: '',
        timestamp,
        attachments: [
          { id: 'image-1', url: 'https://cdn/image.png', filename: 'image.png', contentType: 'image/png', size: 3 },
          { id: 'text-1', url: 'https://cdn/notes.txt', filename: 'notes.txt', contentType: 'text/plain', size: 5 },
        ],
        reactions: [],
        mentions: [],
      }],
    })

    expect(attachments).toHaveLength(2)
    expect(attachments[0]).toMatchObject({ messageId: 'message-1', authorName: 'rat' })
    expect(attachments[0]!.data?.toString()).toBe('png')
    expect(attachments[1]!.data?.toString()).toBe('hello')
  })

  it('archives image/text arrivals idempotently and advertises them in context', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-inbox-'))
    const context = makeContext(root, { capture_attachments: true })
    const attachment: IncomingAttachment = {
      id: 'attachment-1',
      messageId: 'message-1',
      channelId: 'channel-1',
      guildId: 'guild-1',
      authorId: 'user-1',
      authorName: 'rat',
      authorBot: false,
      timestamp: new Date('2026-08-18T12:00:00.000Z'),
      url: '', // Exercise cached-data fallback without a network dependency.
      filename: 'field notes.txt',
      contentType: 'text/plain',
      size: 11,
      data: Buffer.from('hello world'),
    }
    context.incomingAttachments = [attachment]

    await workspacePlugin.onActivation!(context)
    await workspacePlugin.onActivation!(context)

    const stored = join(root, 'inbox', '2026-08-18', 'message-1', 'attachment-1-field notes.txt')
    expect(await fs.readFile(stored, 'utf-8')).toBe('hello world')
    const indexLines = (await fs.readFile(join(root, 'inbox', 'index.jsonl'), 'utf-8')).trim().split('\n')
    expect(indexLines).toHaveLength(1)

    const injections = await workspacePlugin.getContextInjections!(context)
    expect(String(injections[0]!.content)).toContain('inbox/2026-08-18/message-1/attachment-1-field notes.txt')
    expect(String(injections[0]!.content)).toContain('Its organization is yours')
  })

  it('downloads the complete original when a large text attachment was not cached in context', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-inbox-'))
    const context = makeContext(root, { capture_attachments: true })
    const original = 'x'.repeat(300_000) // Larger than Discord context's 200KB text prefix.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(original, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(original)) },
    })))
    context.incomingAttachments = [{
      id: 'large-1',
      messageId: 'message-large',
      channelId: 'channel-1',
      guildId: 'guild-1',
      authorId: 'user-1',
      authorName: 'rat',
      authorBot: false,
      timestamp: new Date('2026-08-18T13:00:00.000Z'),
      url: 'https://cdn.example/large.txt',
      filename: 'large.txt',
      contentType: 'text/plain',
      size: Buffer.byteLength(original),
      truncated: true,
    }]

    await workspacePlugin.onActivation!(context)

    const stored = join(root, 'inbox', '2026-08-18', 'message-large', 'large-1-large.txt')
    expect((await fs.stat(stored)).size).toBe(Buffer.byteLength(original))
    expect(await fs.readFile(stored, 'utf-8')).toBe(original)
  })

  it('drains older inbox candidates across activations without reusing the budget', async () => {
    root = mkdtempSync(join(tmpdir(), 'chapterx-workspace-inbox-'))
    const context = makeContext(root, {
      capture_attachments: true,
      max_inbox_items_per_activation: 1,
    })
    context.incomingAttachments = [
      {
        id: 'older',
        messageId: 'message-old',
        channelId: 'channel-1',
        guildId: 'guild-1',
        authorId: 'user-1',
        authorName: 'rat',
        authorBot: false,
        timestamp: new Date('2026-08-17T12:00:00.000Z'),
        url: '',
        filename: 'older.txt',
        contentType: 'text/plain',
        size: 3,
        data: Buffer.from('old'),
      },
      {
        id: 'newer',
        messageId: 'message-new',
        channelId: 'channel-1',
        guildId: 'guild-1',
        authorId: 'user-1',
        authorName: 'rat',
        authorBot: false,
        timestamp: new Date('2026-08-18T12:00:00.000Z'),
        url: '',
        filename: 'newer.txt',
        contentType: 'text/plain',
        size: 3,
        data: Buffer.from('new'),
      },
    ]

    await workspacePlugin.onActivation!(context)
    await expect(fs.readFile(join(root, 'inbox', '2026-08-18', 'message-new', 'newer-newer.txt'), 'utf-8'))
      .resolves.toBe('new')
    await workspacePlugin.onActivation!(context)
    await expect(fs.readFile(join(root, 'inbox', '2026-08-17', 'message-old', 'older-older.txt'), 'utf-8'))
      .resolves.toBe('old')
  })
})
