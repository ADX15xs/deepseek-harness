/** A growing index window over the ordered Chat rows: everything outside stays unmounted. */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Rows the scrollport has materialized, expressed as an index range into the
 * full entry list. The window starts anchored to the tail (the transcript
 * follows live output) and grows toward the head as the reader scrolls up; it
 * never shrinks within one session view, so DOM anchors it captured stay
 * valid. Unmounted rows keep their last measured height in a shared cache so
 * the placeholder spacers preserve scroll geometry.
 */
export interface MountWindow {
  /** First mounted row index. */
  readonly start: number
  /** One past the last mounted row index. */
  readonly end: number
}

/** Rows kept mounted around the row the reader reaches when the window widens. */
const MOUNT_MARGIN = 40
/** Rows kept mounted when the window first opens at the tail. */
const MOUNT_MINIMUM = 80
/** Height assumed for a row never yet measured, in pixels. */
const ROW_HEIGHT_DEFAULT = 140

/** Last known heights per stable row key; entries never observed use the default. */
export class RowHeightCache {
  private readonly heights = new Map<string, number>()

  /**
    * Records a measured row height for later spacer estimates.
    * @param key - stable render key.
    * @param height - measured outer height in pixels.
    */
  record(key: string, height: number): void {
    if (height > 0) this.heights.set(key, height)
  }

  /**
    * Sums the estimated heights of the given ordered rows.
    * @param keys - stable render keys in order.
    * @returns the summed estimated height in pixels.
    */
  total(keys: readonly string[]): number {
    let sum = 0
    for (const key of keys) sum += this.heights.get(key) ?? ROW_HEIGHT_DEFAULT
    return sum
  }
}

/**
 * Index window over the ordered rows. The window pins to the tail while rows
 * append; the reader reaching the head spacer widens it upward, explicit
 * navigation requests widen it to the target row before that row mounts, and
 * rows prepended above the head shift the window so the mounted rows stay.
 * @param total - current full entry count.
 * @param prependShift - rows prepended above the previous head this render.
 * @returns the window range, the widening callbacks, and the height cache.
 */
export function useMountWindow(total: number, prependShift = 0): {
  readonly window: MountWindow
  /** Widen the window upward when the reader reaches the head spacer. */
  readonly widenHead: () => void
  /** Widen the window so the row at the given index is mounted with margin. */
  readonly ensureMounted: (index: number) => void
  /** Last known row heights for spacer estimates. */
  readonly heights: RowHeightCache
} {
  const [window, setWindow] = useState<MountWindow>(() => ({
    start: Math.max(0, total - MOUNT_MINIMUM),
    end: total,
  }))
  // Render-time reconciliation keeps the slice valid when rows append, without
  // an effect round trip; the head moves toward zero as the reader widens and
  // shifts down-list with rows prepended above it.
  const totalRef = useRef(total)
  if (totalRef.current !== total) {
    totalRef.current = total
    let next = window
    if (prependShift > 0) next = { start: next.start + prependShift, end: next.end + prependShift }
    if (next.end < total || next.start > total - MOUNT_MINIMUM) {
      next = {
        start: Math.max(0, Math.min(next.start, total - MOUNT_MINIMUM)),
        end: Math.max(next.end, total),
      }
    }
    if (next !== window) setWindow(next)
  }
  const heights = useMemo(() => new RowHeightCache(), [])
  const widenHead = useCallback(() => {
    setWindow(previous => previous.start === 0 ? previous
      : { start: Math.max(0, previous.start - MOUNT_MARGIN), end: previous.end })
  }, [])
  const ensureMounted = useCallback((index: number) => {
    setWindow((previous) => {
      if (index >= previous.start && index < previous.end) return previous
      return {
        start: Math.max(0, Math.min(previous.start, index - MOUNT_MARGIN)),
        end: Math.max(previous.end, Math.min(total, index + MOUNT_MARGIN + 1)),
      }
    })
  }, [total])
  return useMemo(() => ({ window, widenHead, ensureMounted, heights }), [window, widenHead, ensureMounted, heights])
}

/**
 * Slice the ordered entries to the mounted range and name the unmounted head
 * rows so their spacer can estimate the room they occupied.
 * @param entries - full ordered entries.
 * @param window - mounted index range.
 * @param chatRenderKey - stable per-entry React key.
 * @returns the mounted rows, their absolute start index, and the unmounted head keys.
 */
export function sliceWindow(
  entries: readonly RenderEntry[],
  window: MountWindow,
  chatRenderKey: (entry: RenderEntry) => string,
): { readonly rows: readonly RenderEntry[]; readonly start: number; readonly headKeys: readonly string[] } {
  const start = Math.min(window.start, entries.length)
  const end = Math.min(window.end, entries.length)
  const headKeys: string[] = []
  for (let index = 0; index < start; index++) headKeys.push(chatRenderKey(entries[index] as RenderEntry))
  return { rows: entries.slice(start, end), start, headKeys }
}
