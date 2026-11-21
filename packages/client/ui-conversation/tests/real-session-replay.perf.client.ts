/**
 * Real-session replay probe (manual perf lane, not a CI gate).
 * Replays a captured Session event log through the Chat projection, checkpointed
 * by event index, to verify per-step cost stays flat on real event shapes
 * (multi-Turn, PTC dispatch, compaction) after the append-side O(N) fixes.
 * Point PERF_REPLAY_LOG at an extracted session.v4.jsonl.
 * Run: pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/real-session-replay.perf.client.ts
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { assistantDefinition } from '../../ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { turnProcessDefinition } from '../../ui-chat/src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../../ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { toolDefinition } from '../../ui-chat/src/client/conversation-nodes/tool.ts'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { processGroupDefinition } from '../../ui-chat/src/client/conversation-nodes/process-groups.ts'

const LOG = process.env.PERF_REPLAY_LOG ?? '.tmp-seq-scan/target.jsonl'
const WINDOW = Number(process.env.PERF_REPLAY_WINDOW ?? 1000)

function makeAssembler(mount: boolean) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [messageDefinition, assistantDefinition, turnProcessDefinition, toolDefinition, turnTailDefinition],
      fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.activateTarget('chat')
  const mounted = new Set<string>()
  const read = (): ChatSnapshot => {
    assembler.flush()
    const snapshot = assembler.snapshot('chat') as ChatSnapshot
    if (mount) {
      for (const key of snapshot.order) {
        if (mounted.has(key)) continue
        mounted.add(key)
        snapshot.nodes.source(key).subscribe(() => {})
        snapshot.nodes.bottomSource(key).subscribe(() => {})
        snapshot.nodes.processSource(key).subscribe(() => {})
      }
    }
    return snapshot
  }
  return { assembler, read, mounted }
}

function run(entries: readonly SessionLiveEventEntry[], mount: boolean) {
  const { assembler, read, mounted } = makeAssembler(mount)
  read()
  const rows: { through: number; nodes: number; windowMs: number; msPerEvent: number; msPerStep: number }[] = []
  let windowStart = performance.now()
  let windowSteps = 0
  for (let index = 0; index < entries.length; index++) {
    assembler.append(entries[index]!)
    const event = entries[index]!.event
    if (event.type === 'step/end') windowSteps++
    if ((index + 1) % WINDOW === 0 || index === entries.length - 1) {
      const snapshot = read()
      const elapsed = performance.now() - windowStart
      rows.push({
        through: index + 1,
        nodes: snapshot.order.length,
        windowMs: elapsed,
        msPerEvent: elapsed / Math.min(WINDOW, index + 1),
        msPerStep: windowSteps > 0 ? elapsed / windowSteps : elapsed / WINDOW,
      })
      windowStart = performance.now()
      windowSteps = 0
    }
  }
  return { rows, mounted: mounted.size }
}

describe('real Session replay scaling', () => {
  it.skipIf(!existsSync(LOG))('per-event cost stays flat across a captured session log', () => {
    const raw = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    const entries: SessionLiveEventEntry[] = []
    let skipped = 0
    for (const line of raw) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { skipped++; continue }
      const record = parsed as { type?: string; seq?: number; event?: { type?: string; seq?: number } }
      // The log holds SessionEventEntry records; wrap live events as the probe feed.
      if (record.type === 'event' && record.event !== undefined) {
        entries.push(record as unknown as SessionLiveEventEntry)
      } else if (typeof record.seq === 'number' && record.type !== undefined && record.event === undefined) {
        // SessionEventEntry {type:'event', event:{...}} forms vary; re-wrap bare events.
        entries.push({ type: 'event', event: parsed as SessionEvent })
      } else skipped++
    }
    console.log(`replay feed: ${entries.length} live events (${skipped} non-event lines skipped)`)
    const mountedRun = run(entries, true)
    const bareRun = run(entries, false)
    const table = (title: string, rows: typeof mountedRun.rows) => {
      console.log(`\n=== ${title} ===`)
      console.log('through\tnodes\twindow ms\tms/event\tms/step')
      for (const r of rows) console.log(`${r.through}\t${r.nodes}\t${r.windowMs.toFixed(1)}\t${r.msPerEvent.toFixed(3)}\t${r.msPerStep.toFixed(3)}`)
    }
    table('REAL SESSION, ALL ROWS MOUNTED', mountedRun.rows)
    table('REAL SESSION, NO SUBSCRIBERS', bareRun.rows)
    const quarters = mountedRun.rows.filter((_, i) => i % Math.max(1, Math.floor(mountedRun.rows.length / 4)) === 0)
    const first = quarters[0]
    const last = quarters[quarters.length - 1]
    if (first && last) console.log(`\nms/event x${(last.msPerEvent / first.msPerEvent).toFixed(2)} while nodes x${(last.nodes / first.nodes).toFixed(2)}`)
    expect(mountedRun.rows.length).toBeGreaterThan(0)
  }, 600_000)
})
