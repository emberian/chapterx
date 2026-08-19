/**
 * Notes Plugin — index + retrieval architecture
 *
 * Injects a compact index (ID + first line) into context every turn.
 * Full note content is retrieved on-demand via read_note.
 */

import { ToolPlugin, PluginContext, PluginStateContext, ContextInjection } from './types.js'
import { logger } from '../../utils/logger.js'

interface Note {
  id: string
  content: string
  createdAt: string
  createdByMessageId: string
}

interface NotesState {
  notes: Note[]
  lastModifiedMessageId: string | null
}

/** First line of note content, truncated. The bot sees this in the index. */
function noteTitle(content: string, maxLen = 100): string {
  const firstLine = content.split('\n')[0] || content
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen) + '…'
}

const plugin: ToolPlugin = {
  name: 'notes',
  description: 'Notebook with persistent notes. Index is always visible; use read_note for full content.',

  tools: [
    {
      name: 'save_note',
      description:
        'Save a note. The first line will appear in your notebook index; use it as a title.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The note content to save',
          },
        },
        required: ['content'],
      },
      handler: async (input: { content: string }, context: PluginContext) => {
        logger.debug(
          { content: input.content.slice(0, 50), channelId: context.channelId },
          'Note save requested'
        )
        return `Note will be saved: "${input.content.slice(0, 50)}${input.content.length > 50 ? '...' : ''}"`
      },
    },
    {
      name: 'list_notes',
      description: 'List all saved notes with their IDs and titles.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_input: any, context: PluginContext) => {
        logger.debug({ channelId: context.channelId }, 'Notes list requested')
        return 'Fetching notes index...'
      },
    },
    {
      name: 'read_note',
      description: 'Read the full content of a specific note by its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The note ID (e.g., note_abc123)',
          },
        },
        required: ['id'],
      },
      handler: async (input: { id: string }, context: PluginContext) => {
        logger.debug(
          { noteId: input.id, channelId: context.channelId },
          'Note read requested'
        )
        return `Looking up note: ${input.id}`
      },
    },
    {
      name: 'search_notes',
      description: 'Search notes by content. Returns matching note IDs and titles.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term to find in note contents',
          },
        },
        required: ['query'],
      },
      handler: async (input: { query: string }, context: PluginContext) => {
        logger.debug(
          { query: input.query, channelId: context.channelId },
          'Note search requested'
        )
        return `Searching notes for: ${input.query}`
      },
    },
    {
      name: 'delete_note',
      description: 'Delete a note by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the note to delete',
          },
        },
        required: ['id'],
      },
      handler: async (input: { id: string }, context: PluginContext) => {
        logger.debug(
          { noteId: input.id, channelId: context.channelId },
          'Note delete requested'
        )
        return `Note ${input.id} will be deleted`
      },
    },
  ],

  /**
   * Inject a compact index every turn. The bot always knows what it has;
   * it calls read_note when it needs the details.
   */
  getContextInjections: async (
    context: PluginStateContext
  ): Promise<ContextInjection[]> => {
    const config = context.pluginConfig as
      | { inject_into_context?: boolean }
      | undefined
    if (config?.inject_into_context === false) {
      return []
    }

    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope)

    if (!state?.notes.length) {
      return []
    }

    const indexLines = state.notes.map(
      (note, i) => `${i + 1}. [${note.id}] ${noteTitle(note.content)}`
    )

    const indexContent = [
      `## 📝 Notebook (${state.notes.length} notes)`,
      '',
      ...indexLines,
      '',
      '_Use read_note to see full contents. Use save_note/delete_note to manage._',
    ].join('\n')

    return [
      {
        id: 'notes-display',
        content: indexContent,
        targetDepth: 10,
        lastModifiedAt: state.lastModifiedMessageId,
        priority: 100,
      },
    ]
  },

  /**
   * Persist state changes after save/delete.
   */
  onToolExecution: async (
    toolName: string,
    input: any,
    _result: any,
    context: PluginStateContext
  ): Promise<void> => {
    const scope = context.configuredScope
    const state = (await context.getState<NotesState>(scope)) || {
      notes: [],
      lastModifiedMessageId: null,
    }

    if (toolName === 'save_note') {
      const newNote: Note = {
        id: `note_${Date.now().toString(36)}`,
        content: input.content,
        createdAt: new Date().toISOString(),
        createdByMessageId: context.currentMessageId,
      }

      state.notes.push(newNote)
      state.lastModifiedMessageId = context.currentMessageId

      await context.setState(scope, state)
      logger.info(
        { noteId: newNote.id, channelId: context.channelId, scope },
        'Note saved'
      )
    }

    if (toolName === 'delete_note') {
      const noteIndex = state.notes.findIndex((n) => n.id === input.id)
      if (noteIndex >= 0) {
        state.notes.splice(noteIndex, 1)
        state.lastModifiedMessageId = context.currentMessageId

        await context.setState(scope, state)
        logger.info(
          { noteId: input.id, channelId: context.channelId, scope },
          'Note deleted'
        )
      }
    }
  },

  /**
   * Replace handler placeholders with real data for read/search/list.
   */
  postProcessResult: async (
    toolName: string,
    input: any,
    result: string,
    context: PluginStateContext
  ): Promise<string> => {
    const scope = context.configuredScope
    const state = await context.getState<NotesState>(scope)

    if (toolName === 'read_note') {
      if (!state?.notes.length) return 'No notes saved yet.'

      const note = state.notes.find((n) => n.id === input.id)
      if (note) {
        return `**[${note.id}]** (${note.createdAt}):\n\n${note.content}`
      }
      return `Note not found: ${input.id}`
    }

    if (toolName === 'search_notes') {
      if (!state?.notes.length) return 'No notes saved yet.'

      const q = (input.query as string).toLowerCase()
      const matches = state.notes.filter((n) =>
        n.content.toLowerCase().includes(q)
      )

      if (matches.length === 0) {
        return `No notes matching "${input.query}".`
      }

      // Single match: return full content directly
      if (matches.length === 1) {
        const note = matches[0]!
        return `**[${note.id}]** (${note.createdAt}):\n\n${note.content}`
      }

      // Multiple matches: return index so bot can pick
      return (
        `${matches.length} notes matching "${input.query}":\n\n` +
        matches
          .map((n) => `- [${n.id}] ${noteTitle(n.content)}`)
          .join('\n')
      )
    }

    if (toolName === 'list_notes') {
      if (!state?.notes.length) return 'No notes saved yet.'

      return (
        `**${state.notes.length} notes:**\n\n` +
        state.notes
          .map((n, i) => `${i + 1}. [${n.id}] ${noteTitle(n.content)}`)
          .join('\n')
      )
    }

    // save_note and delete_note: handler response is fine as-is
    return result
  },
}

export default plugin

