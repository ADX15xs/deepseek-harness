/**
 * Single-Turn projection scaling probe (manual perf lane, not a CI gate).
 * Reproduces the reported pathology: ONE Turn accumulating hundreds of Steps,
 * every row mounted (detailed / fully-expanded). Measures per-Step append+flush
 * cost as the loaded node count N grows, to expose the O(N^2) structural path.
 * Run: pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/single-turn-projection.perf.client.ts
 */
import { describe, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
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

const TURN = 1
function entry(event: SessionEvent): SessionLiveEventEntry { return { type: 'event', event } }

/** One Step = assistant tool-call message + tool/call + tool/result, bracketed by step start/end. */
function stepEvents(step: number, seqBase: number): SessionLiveEventEntry[] {
  const callId = ToolCallId(`call-${step}`)
  const args = JSON.stringify({ command: `echo step ${step}` })
  const t = seqBase * 100
  return [
    entry({ type: 'step/start', seq: SessionSeq(seqBase), time: t, data: { turn: TURN, step } }),
    entry({ type: 'assistant/message', seq: SessionSeq(seqBase + 1), time: t + 10, surfaceOp: 'append', data: {
      turn: TURN, step, stream: [],
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: args }] }),
    } }),
    entry({ type: 'tool/call', seq: SessionSeq(seqBase + 2), time: t + 20,
      data: { turn: TURN, step, callId, name: 'run_code', arguments: args } }),
    entry({ type: 'tool/result', seq: SessionSeq(seqBase + 3), time: t + 30, surfaceOp: 'append', data: {
      turn: TURN, step, message: createToolResultMessage({ callId,
        content: [{ type: 'text', text: `output of step ${step}` }], isError: false }),
    } }),
    entry({ type: 'step/end', seq: SessionSeq(seqBase + 4), time: t + 40, data: { turn: TURN, step } }),
  ]
}

function makeAssembler(mount: boolean) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [messageDefinition, assistantDefinition, turnProcessDefinition, toolDefinition, turnTailDefinition],
      fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.replaceWindow([
    entry({ type: 'turn/start', seq: SessionSeq(1), time: 100, data: { turn: TURN } }),
  ], false)
  assembler.activateTarget('chat')
  const mounted = new Set<string>()
  const read = (): ChatSnapshot => {
    assembler.flush()
    const snapshot = assembler.snapshot('chat') as ChatSnapshot
    if (mount) {
      // Simulate fully-expanded mode: every row keeps its three per-key sources subscribed.
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

function run(maxSteps: number, mount: boolean) {
  const { assembler, read, mounted } = makeAssembler(mount)
  read()
  const checkpoints = [25, 50, 100, 200, 300, 400, 500, 600, 900, 1200, 1500, 1800].filter(c => c <= maxSteps)
  const rows: { steps: number; nodes: number; perStepMs: number; cumMs: number }[] = []
  let seq = 10
  let cum = 0
  let windowStart = performance.now()
  let windowSteps = 0
  let lastCheckpoint = 0
  for (let step = 1; step <= maxSteps; step++) {
    const events = stepEvents(step, seq)
    seq += 5
    const t0 = performance.now()
    for (const e of events) assembler.append(e)
    read()
    const dt = performance.now() - t0
    cum += dt
    windowSteps++
    if (checkpoints.includes(step)) {
      const elapsed = performance.now() - windowStart
      const nodes = (assembler.snapshot('chat') as ChatSnapshot).order.length
      rows.push({ steps: step, nodes, perStepMs: elapsed / windowSteps, cumMs: cum })
      windowStart = performance.now()
      windowSteps = 0
      lastCheckpoint = step
    }
  }
  return { rows, mounted: mounted.size, lastCheckpoint }
}

describe('single-Turn projection scaling', () => {
  it('per-Step cost grows with loaded node count (mounted rows)', () => {
    const maxSteps = Number(process.env.PERF_STEPS ?? 600)
    const mountedRun = run(maxSteps, true)
    const bareRun = run(maxSteps, false)
    console.log('\n=== SINGLE TURN, ALL ROWS MOUNTED (detailed/verbose) ===')
    console.log('steps\tnodes\tper-step ms\tcumulative ms')
    for (const r of mountedRun.rows) {
      console.log(`${r.steps}\t${r.nodes}\t${r.perStepMs.toFixed(3)}\t${r.cumMs.toFixed(1)}`)
    }
    console.log('\n=== SINGLE TURN, NO SUBSCRIBERS (projection only) ===')
    console.log('steps\tnodes\tper-step ms\tcumulative ms')
    for (const r of bareRun.rows) {
      console.log(`${r.steps}\t${r.nodes}\t${r.perStepMs.toFixed(3)}\t${r.cumMs.toFixed(1)}`)
    }
    const first = mountedRun.rows[0]
    const last = mountedRun.rows[mountedRun.rows.length - 1]
    if (first && last) {
      const growth = last.perStepMs / first.perStepMs
      const sizeGrowth = last.nodes / first.nodes
      console.log(`\nper-step cost x${growth.toFixed(2)} while node count x${sizeGrowth.toFixed(2)} (linear-in-N per step => quadratic total)`)
    }
  }, 600_000)
})
