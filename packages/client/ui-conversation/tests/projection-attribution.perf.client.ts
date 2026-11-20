/**
 * Attribution probe: which pass inside per-Step append+flush dominates at scale?
 * Times the same single-Turn workload as single-turn-projection.perf.client.ts
 * and prints late-window averages per phase. Manual perf lane.
 * Run: pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/projection-attribution.perf.client.ts
 */
import { describe, it } from 'vitest'
import { Session } from 'node:inspector'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { assistantDefinition } from '../../ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { turnProcessDefinition } from '../../ui-chat/src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../../ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { toolDefinition } from '../../ui-chat/src/client/conversation-nodes/tool.ts'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { processGroupDefinition } from '../../ui-chat/src/client/conversation-nodes/process-groups.ts'

const TURN = 1

function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

function stepEvents(step: number, seqBase: number): SessionLiveEventEntry[] {
  const callId = ToolCallId(`call-${step}`)
  const args = JSON.stringify({ command: `echo step ${step}` })
  const time = seqBase * 100
  return [
    entry({ type: 'step/start', seq: SessionSeq(seqBase), time, data: { turn: TURN, step } }),
    entry({ type: 'assistant/message', seq: SessionSeq(seqBase + 1), time: time + 10, surfaceOp: 'append', data: {
      turn: TURN,
      step,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: args }],
      }),
    } }),
    entry({ type: 'tool/call', seq: SessionSeq(seqBase + 2), time: time + 20,
      data: { turn: TURN, step, callId, name: 'run_code', arguments: args } }),
    entry({ type: 'tool/result', seq: SessionSeq(seqBase + 3), time: time + 30, surfaceOp: 'append', data: {
      turn: TURN,
      step,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `output of step ${step}` }],
        isError: false,
      }),
    } }),
    entry({ type: 'step/end', seq: SessionSeq(seqBase + 4), time: time + 40, data: { turn: TURN, step } }),
  ]
}

function makeAssembler(): { assembler: ConversationNodeAssembler; mountRows: (snapshot: ChatSnapshot) => void } {
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
  const mountRows = (snapshot: ChatSnapshot): void => {
    for (const key of snapshot.order) {
      if (mounted.has(key)) continue
      mounted.add(key)
      snapshot.nodes.source(key).subscribe(() => {})
      snapshot.nodes.bottomSource(key).subscribe(() => {})
      snapshot.nodes.processSource(key).subscribe(() => {})
    }
  }
  return { assembler, mountRows }
}

interface PhaseTimes { append: number; flush: number; mount: number }
interface InspectorSession {
  connect(): void
  post(method: string, params?: object, callback?: (error: Error | null, result?: object) => void): void
}

/** Flush pending microtasks so inspector posts queue behind the hot loop. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function run(maxSteps: number, sampleFromStep?: number): { phases: PhaseTimes[]; stop: (() => Promise<object>) | undefined } {
  const session = new Session() as unknown as InspectorSession
  session.connect()
  const post = (method: string, params?: object): Promise<object> => new Promise((resolve, reject) => {
    session.post(method, params, (error: Error | null, result?: object) => error ? reject(error) : resolve(result ?? {}))
  })
  const { assembler, mountRows } = makeAssembler()
  assembler.flush()
  mountRows(assembler.snapshot('chat') as ChatSnapshot)
  let seq = 10
  let samplingStarted = false
  const phases: PhaseTimes[] = []
  for (let step = 1; step <= maxSteps; step++) {
    if (sampleFromStep !== undefined && step === sampleFromStep && !samplingStarted) {
      samplingStarted = true
      void post('Profiler.enable')
      void post('Profiler.setSamplingInterval', { interval: 200 })
      void post('Profiler.start')
    }
    const events = stepEvents(step, seq)
    seq += 5
    const appendStart = performance.now()
    for (const item of events) assembler.append(item)
    const appendEnd = performance.now()
    assembler.flush()
    const flushEnd = performance.now()
    mountRows(assembler.snapshot('chat') as ChatSnapshot)
    const mountEnd = performance.now()
    phases.push({ append: appendEnd - appendStart, flush: flushEnd - appendEnd, mount: mountEnd - flushEnd })
  }
  const stop = samplingStarted
    ? async (): Promise<object> => {
      await settle()
      return post('Profiler.stop')
    }
    : undefined
  return { phases, stop }
}

function average(phases: PhaseTimes[], from: number, pick: (phase: PhaseTimes) => number): string {
  const slice = phases.slice(from)
  return (slice.reduce((total, phase) => total + pick(phase), 0) / slice.length).toFixed(3)
}

describe('projection attribution', () => {
  it('phase split across the run', () => {
    const maxSteps = Number(process.env.PERF_STEPS ?? 1800)
    const { phases } = run(maxSteps)
    console.log('\n=== PHASE SPLIT (per-step ms) ===')
    for (const from of [0, 300, 600, 900, 1200, 1500]) {
      if (from >= maxSteps) continue
      console.log(`steps ${String(from + 1).padStart(4)}-${maxSteps}: append ${average(phases, from, p => p.append)}, flush ${average(phases, from, p => p.flush)}, mount ${average(phases, from, p => p.mount)}`)
    }
  }, 600_000)

  it('CPU profile of late steps ranks hot functions', async () => {
    const profilePath = process.env.PERF_PROFILE
    const { phases, stop } = run(1800, 1200)
    console.log('\n=== LATE WINDOW (steps 1201-1800, per-step ms) ===')
    console.log(`append ${average(phases, 1200, p => p.append)}, flush ${average(phases, 1200, p => p.flush)}, mount ${average(phases, 1200, p => p.mount)}`)
    if (stop === undefined || profilePath === undefined) {
      console.log('set PERF_PROFILE=<path> to capture a CPU profile (skipped)')
      return
    }
    const result = await stop() as { profile?: object }
    if (result.profile === undefined) throw new Error('Profiler.stop returned no profile')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(profilePath, JSON.stringify(result.profile))
    console.log('profile written to', profilePath)
  }, 600_000)
})
