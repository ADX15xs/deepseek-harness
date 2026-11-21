// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  NodeKey, RenderEntry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  Button, FenceCodeBlock, IconChevronDownOutlineRegular, MarkdownDelegateProvider, Modal,
  type MarkdownDelegateFenceInfo, type MarkdownMenuTarget,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isAtOrOutside } from '../contract/group-tree.ts'
import type { ChatFlowHookContext, ChatViewSlotProps, OpenFileOptions } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { TurnNavigator } from './TurnNavigator.tsx'
import { ChatAside } from './ChatAside.tsx'
import { mergeTurnRailItems } from './turn-rail-items.ts'
import { useTextInteraction } from './text-interaction.ts'
import { useChatScroll } from './use-chat-scroll.ts'
import { chatRenderKey } from './render-entry.ts'
import { sliceWindow, useMountWindow } from './use-mount-window.ts'
import { fileMediaUrl, resolveWorkspacePath, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import css from './ChatView.module.css'

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/**
 * Durable input identities suppress matching echoes in the same render.
 * The last input's Turn also distinguishes an empty opening control from
 * one whose human input or trigger notice is already present.
 */
function observedInputs(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
): { readonly rpcIds: ReadonlySet<string>; readonly lastInputTurn: number | undefined } {
  const observed = new Set<string>()
  let lastInputTurn: number | undefined
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || !isAtOrOutside(node, 'input')) continue
    if (node.location.kind === 'turn' || node.location.kind === 'step') lastInputTurn = node.location.turn.turn
    const data: unknown = node.data
    const source = typeof data === 'object' && data !== null && 'source' in data ? data.source : undefined
    if (typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'user'
      && 'rpcId' in source && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  return { rpcIds: observed, lastInputTurn }
}

type PendingInput = PendingSubmission | InboxState['next-step'][number]

/** How long fold transitions stay enabled after a Turn stops running. */
const MOTION_TAIL_MS = 800

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useConversation, useSessions, renderSlot,
  sessionId, openFile, openExternalLink, resolveFilePath, useContextMenu,
  loadOlder, consumeOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt,
  usePresentation, useProjection, useInteractionIds, dispatchInteraction, t, fileDrag,
}: ChatViewSlotProps) {
  const { getTriggerProps } = useContextMenu()
  const getMarkdownTriggerProps = useCallback((target: MarkdownMenuTarget) => getTriggerProps(() => {
    switch (target.kind) {
      case 'file': return { kind: 'file', value: { sessionId, path: resolveFilePath(target.path),
        ...(target.line === undefined ? {} : { line: target.line }) } }
      case 'url': return { kind: 'url', value: { sessionId, url: target.url } }
      case 'image': return { kind: 'image', value: { sessionId, url: target.url,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.mediaType === undefined ? {} : { mediaType: target.mediaType }),
        ...(target.path === undefined ? {} : { path: resolveFilePath(target.path) }) } }
    }
  }), [getTriggerProps, resolveFilePath, sessionId])
  const order = useChat(s => s.order)
  const groupedEntries = useConversation(snapshot => snapshot.views.grouped('chat')?.entries)
  const entries = useMemo<readonly RenderEntry[]>(() => groupedEntries
    ?? order.map(key => ({ kind: 'node', key: key as NodeKey })), [groupedEntries, order])
  // History paging prepends rows above the previous head; shifting the window
  // by their count keeps the mounted row set unchanged instead of mounting
  // every loaded page. A replaced head the shift cannot find keeps the window.
  const headKey = entries.length === 0 ? null : chatRenderKey(entries[0] as RenderEntry)
  const headKeyRef = useRef<string | null>(null)
  let prependShift = 0
  const previousHeadKey = headKeyRef.current
  if (previousHeadKey !== null && headKey !== null && headKey !== previousHeadKey) {
    const shift = entries.findIndex(entry => chatRenderKey(entry) === previousHeadKey)
    if (shift > 0) prependShift = shift
  }
  headKeyRef.current = headKey
  // Rows outside the mount window stay unmounted; the window keeps the tail
  // mounted for live output and widens toward the head as the reader scrolls.
  const { window: mountWindow, widenHead, ensureMounted, heights } = useMountWindow(entries.length, prependShift)
  const flow = useMemo(() => sliceWindow(entries, mountWindow, chatRenderKey), [entries, mountWindow])
  const headSpacerHeight = useMemo(
    () => mountWindow.start === 0 ? 0 : heights.total(flow.headKeys),
    [mountWindow.start, heights, flow.headKeys],
  )
  const headSpacerRef = useRef<HTMLDivElement>(null)
  const headSpacerHeightRef = useRef(headSpacerHeight)
  headSpacerHeightRef.current = headSpacerHeight
  const headSpacerRoomy = headSpacerHeight > 0
  // Reaching the head spacer means the reader scrolled past the mounted head;
  // widening moves rows into the window while the spacer hands their height back.
  useEffect(() => {
    if (!headSpacerRoomy) return
    const sentinel = headSpacerRef.current
    if (sentinel === null || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver((observed) => {
      if (observed.some(entry => entry.isIntersecting)) widenHead()
    }, { rootMargin: '25% 0%' })
    observer.observe(sentinel)
    return () => { observer.disconnect() }
  }, [widenHead, headSpacerRoomy])
  const nodeStore = useChat(s => s.nodes)
  const deferCompletedTurns = usePresentation(policy => policy.collapseTiming === 'next-input')
  const transcriptView = usePresentation(policy => policy.mode)
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const inbox = useProjection('inbox') as InboxState | undefined
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    fileDrag,
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    resourceAddress: (path: string) => sessionFileAddress(sessionId, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t, fileDrag, sessionId])
  const codeLabels = useMemo(() => markdownLabels(t).code, [t])
  // Every fence in the flow dispatches by language; the content is the plain
  // code block, so a language without a layer renders as code without diff rows.
  const renderCode = useCallback((fence: MarkdownDelegateFenceInfo) => renderSlot('conversation.chat.markdown.fence', fence, {
    entryKey: fence.lang,
    children: (
      <FenceCodeBlock lang={fence.lang} code={fence.code} streaming={fence.streaming} labels={codeLabels} diff={false} />
    ),
  }), [renderSlot, codeLabels])
  const running = useSession(s => s.running)
  // Fold transitions run while a Turn is live, while an input is pending, and briefly after settling.
  const [motionTail, setMotionTail] = useState(false)
  useEffect(() => {
    if (!deferCompletedTurns) {
      setMotionTail(false)
      return
    }
    if (running) {
      setMotionTail(true)
      return
    }
    const timer = setTimeout(() => { setMotionTail(false) }, MOTION_TAIL_MS)
    return () => { clearTimeout(timer) }
  }, [running, deferCompletedTurns])
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const historyLoadStatus = useSession(s => s.historyLoadStatus)
  const historyWasPartial = useSession(s => s.historyWasPartial)
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string, options?: OpenFileOptions) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t('fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const inboxSteering = useMemo(
    () => inbox?.['next-step'].filter(message => message.source.kind === 'user') ?? [],
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const [visibleSubmissions, lastInputTurn] = useMemo(() => {
    if (pendingSubmissions.length === 0) return [pendingSubmissions, undefined] as const
    const observed = observedInputs(order, nodeStore)
    return [pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.rpcIds.has(submission.requestId)
    )), observed.lastInputTurn] as const
  }, [pendingSubmissions, order, nodeStore])
  const pendingInputs = useMemo(() => {
    const local = new Map(visibleSubmissions.map(submission => [submission.requestId, submission]))
    // Admitted local identities outlive their bubbles until the Inbox claim watermark.
    const localIds = new Set(pendingSubmissions.filter(submission => submission.placement !== 'queued')
      .map(submission => submission.requestId))
    const pending = inboxSteering.flatMap<PendingInput>((item) => {
      const source = item.source
      if (source.kind !== 'user' || !('rpcId' in source)) return [item]
      const submission = local.get(source.rpcId)
      if (submission === undefined) return localIds.has(source.rpcId) ? [] : [item]
      local.delete(source.rpcId)
      return [submission]
    })
    return [...pending, ...local.values()]
  }, [inboxSteering, pendingSubmissions, visibleSubmissions])
  const deferCollapse = deferCompletedTurns
    && !pendingInputs.some(item => 'requestId' in item && item.placement === 'transcript')

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const latestSteering = pendingInputs.findLast(item => 'source' in item)
  const steeringId = latestSteering?.source.kind === 'user' && 'rpcId' in latestSteering.source
    ? latestSteering.source.rpcId : latestSteering?.id ?? null
  const scroll = useChatScroll({
    isOpen: openState === 'open',
    order, firstSeq, lastKey, running, loadingOlder, historyLoadStatus, hasMore, chatScroll,
    loadOlder, consumeOlder, loadThrough, deferCompletedTurns,
    lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === 'user',
    steeringId,
    submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
    submissionSteers: visibleSubmissions.at(-1)?.placement === 'steering',
    loadedTurns: turnNavigationItems,
    transcriptView,
  })
  const interactionSurfaceRef = useRef<HTMLDivElement>(null)
  const interactionIds = useInteractionIds(ids => ids)
  const textInteraction = useTextInteraction(scroll.columnRef, interactionSurfaceRef, dispatchInteraction, interactionIds)
  const flowContext = useMemo<ChatFlowHookContext>(() => ({ motion: scroll.motion }), [scroll.motion])
  // Record mounted row heights so unmounted head rows keep their scroll room
  // estimated. Every row root carries data-chat-anchor-key, so matching those
  // elements in order stays correct regardless of status blocks rendered ahead.
  useLayoutEffect(() => {
    const column = scroll.columnRef.current
    if (column === null) return
    const rows = Array.from(column.children).filter(
      element => element instanceof HTMLElement && element.dataset.chatAnchorKey !== undefined,
    )
    for (let index = 0; index < flow.rows.length; index++) {
      const element = rows[index] as HTMLElement | undefined
      if (element !== undefined) heights.record(chatRenderKey(flow.rows[index] as RenderEntry), element.offsetHeight)
    }
  })
  // Rail jumps to an earlier Turn must find that Turn's anchor mounted before
  // the viewport can align to it. The anchor resolves against the grouped
  // entries, whose node references carry the same keys in grouped and flat
  // modes; when the row sits outside the mount window, widen first and issue
  // the navigation from the widened commit.
  const pendingAnchorRef = useRef<typeof railItems[number] | null>(null)
  const navigateToTurn = useCallback((item: typeof railItems[number]) => {
    if (item.anchor.kind === 'loaded') {
      const anchorKey = item.anchor.key
      const index = entries.findIndex(entry => entry.kind === 'node' && entry.key === anchorKey)
      if (index >= 0 && (index < mountWindow.start || index >= mountWindow.end)) {
        pendingAnchorRef.current = item
        ensureMounted(index)
        return
      }
    }
    pendingAnchorRef.current = null
    scroll.navigateToTurn(item)
  }, [entries, mountWindow, ensureMounted, scroll.navigateToTurn])
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    if (pending === null || pending.anchor.kind !== 'loaded') return
    const anchorKey = pending.anchor.key
    const index = entries.findIndex(entry => entry.kind === 'node' && entry.key === anchorKey)
    if (index < 0 || index < mountWindow.start || index >= mountWindow.end) return
    pendingAnchorRef.current = null
    scroll.navigateToTurn(pending)
  })

  return (
    <div className={css.frame}>
      {scroll.initialized && (
        <TurnNavigator
          items={railItems}
          activeTurn={scroll.activeTurn}
          busyTurn={scroll.busyTurn}
          onNavigate={navigateToTurn}
          t={t}
        />
      )}
      <ChatAside renderSlot={renderSlot} />
      <div className={css.root} data-chat-following-tail={scroll.followingTail ? '' : undefined}>
        <div ref={scroll.listRef} className={css.scroll}>
          <div ref={scroll.columnRef} className={css.column} data-chat-flow=""
            data-chat-motion={deferCompletedTurns && scroll.initialized
              && (running || motionTail || pendingInputs.length > 0) ? '' : undefined}>
            {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
            {openState === 'error' && openError !== null && (
              <div className={css.openError}>
                {t('chat.loadError', { message: openError.message, code: openError.code })}
              </div>
            )}
            {(hasMore || historyWasPartial) && (
              <div className={css.older} ref={scroll.historyEdgeRef} data-chat-history={historyLoadStatus}>
                <button type="button" disabled={!hasMore}
                  onClick={scroll.loadEarlier}>
                  {([
                    ['more', t('chat.loadOlder')],
                    ['loading', t('chat.loadingOlder')],
                    ['processing', t('chat.processingOlder')],
                    ['error', t('chat.retryOlder')],
                    ['start', t('chat.historyStart')],
                  ] as const).map(([state, label]) => {
                    const current = !hasMore ? 'start' : loadingOlder ? 'loading'
                      : historyLoadStatus === 'error' ? 'error'
                        : scroll.historyInputHeld ? 'more'
                          : scroll.historyProcessing ? 'processing' : 'more'
                    return <span key={state} aria-hidden={state !== current}
                      className={state === current ? undefined : css.historyHidden}>{label}</span>
                  })}
                </button>
              </div>
            )}
            {/* Unmounted head rows keep their measured height here; the reader
                reaching this room widens the mount window upward. */}
            <div ref={headSpacerRef} className={css.turnSpacer}
              data-chat-head-spacer aria-hidden="true" style={{ height: headSpacerHeight }} />
            <MarkdownDelegateProvider
              getTriggerProps={getMarkdownTriggerProps}
              openFile={requestOpenFile}
              openExternalLink={openExternalLink}
              fileImages={fileImages}
              renderCode={renderCode}
            >
              {renderSlot('conversation.chat.flow', {
                entries: flow.rows, pendingInputs, lastInputTurn, deferCollapse,
                cwd, openFile: requestOpenFile, inspectCall, forkAt, loadImage,
              }, { hookContext: flowContext })}
            </MarkdownDelegateProvider>
            <div ref={interactionSurfaceRef} className={css.textInteraction} data-text-interaction-surface=""
              aria-hidden={textInteraction.active === null}>
              {textInteraction.active !== null && renderSlot('conversation.chat.text-interaction', {
                trigger: textInteraction.active.trigger, readText: textInteraction.readText,
                dismiss: textInteraction.dismiss, clearSelection: textInteraction.clearSelection,
              }, { entryKey: textInteraction.active.id })}
            </div>
            {/* No pending placeholders: questions (ui-user-questions) and approvals
                (ApprovalPanel) both take over the composer, so a flow card would
                double-render the same wait. */}
          </div>
          {/* Fold room is reclaimed by viewport scroll, content-growth, and display-mode policies. */}
          <div className={css.turnSpacer} data-chat-turn-spacer aria-hidden="true" />
        </div>
      </div>
      {!scroll.followingTail && (
        <div className={css.toBottomSlot}>
          <button
            type="button"
            className={css.toBottom}
            aria-label={t('chat.toBottom')}
            onClick={scroll.returnToBottom}
          >
            <IconChevronDownOutlineRegular size={16} />
          </button>
        </div>
      )}
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  message, busy, onClose, onRetry, t,
}: {
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
