import {
  SCHEMA_VERSION,
  type ClipboardData,
  type PolishedAction,
  type PolishedSession,
  type ScreenAfterDelta,
  type TargetResolution,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { redactEvent, sanitizeUrl, shouldDropEvent } from '../../shared/telemetry/sanitize'

/** Prefer structured urlHost; fall back when AX stuffed the page URL into the title. */
function urlHostFromEvent(event: TelemetryEvent): string | undefined {
  if (event.data?.urlHost) return event.data.urlHost
  const title = event.data?.documentTitle || event.data?.windowTitle
  if (title && /^https?:\/\//i.test(title)) {
    const s = sanitizeUrl(title)
    if (!s.rejected && s.urlHost) return s.urlHost
  }
  return undefined
}
import { attachNarration } from './narration'
import { classifyInputKind, segmentActions, semanticOpFromShortcut } from './segment'
import { resolveTargetResolution } from './axTarget'
import type { TelemetryStore } from './store/TelemetryStore'

const IDLE_GAP_MS = 30_000
const CLICK_COLLAPSE_MS = 800
const PASTE_CHAIN_MS = 8_000
const FOCUS_FOLD_MS = 2_000

const TEXT_FIELD_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXSearchField'
])

type ActionDraft = Omit<PolishedAction, 'order'> & { order?: number }

type PendingClipboard = {
  event: TelemetryEvent
  clip: ClipboardData
  at: number
  pairId?: string
  sourceLabel?: string
}

type PendingPaste = {
  event: TelemetryEvent
  at: number
  pairId?: string
  transferSourceLabel?: string
  transferDestLabel?: string
}

/**
 * Deterministic polisher — sorts, dedupes, re-redacts, collapses noise,
 * preserves structured evidence, merges copy→paste→send chains,
 * L1-denoises fill_field / transfer / reveal, attaches state transitions /
 * waits / target resolution, folds focus into the following interaction,
 * and marks verified outcomes. Does not invent user intent.
 */
export async function polishSession(
  store: TelemetryStore,
  sessionId: string
): Promise<PolishedSession> {
  const raw = await store.readSessionEvents(sessionId)
  const byId = new Map<string, TelemetryEvent>()
  for (const e of raw) {
    const redacted = redactEvent(e)
    if (shouldDropEvent(redacted)) continue
    if (!byId.has(redacted.eventId)) byId.set(redacted.eventId, redacted)
  }

  const events = [...byId.values()].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    return a.timestamp.localeCompare(b.timestamp)
  })

  const drafts: ActionDraft[] = []
  let lastClickKey: string | null = null
  let lastClickAt = 0
  let pendingField: TelemetryEvent | null = null
  let lastNav: TelemetryEvent | null = null
  let lastDocKey: string | null = null
  let lastTs = 0
  let pendingWaitMs = 0
  let lastScreenId: string | undefined
  let lastScreenDelta: ScreenAfterDelta | undefined
  let pendingClipboard: PendingClipboard | null = null
  let pendingPaste: PendingPaste | null = null
  let pendingFocus: { draftIndex: number; at: number; label?: string; role?: string } | null =
    null

  const push = (draft: ActionDraft) => {
    if (pendingWaitMs > 0 && draft.category !== 'idle' && draft.category !== 'session') {
      draft.waitedMs = (draft.waitedMs ?? 0) + pendingWaitMs
      pendingWaitMs = 0
    }
    if (lastScreenId && !draft.screenBeforeId && draft.category !== 'session') {
      draft.screenBeforeId = lastScreenId
    }
    drafts.push(draft)
  }

  const adjustPendingFocusAfterSplice = (removedIndex: number) => {
    if (!pendingFocus) return
    if (pendingFocus.draftIndex === removedIndex) {
      pendingFocus = null
    } else if (pendingFocus.draftIndex > removedIndex) {
      pendingFocus.draftIndex -= 1
    }
  }

  const removeDraftContainingEvent = (eventId: string): ActionDraft | null => {
    for (let i = drafts.length - 1; i >= 0; i--) {
      if (drafts[i].sourceEventIds.includes(eventId)) {
        const [removed] = drafts.splice(i, 1)
        adjustPendingFocusAfterSplice(i)
        return removed
      }
    }
    return null
  }

  const foldPendingFocus = (draft: ActionDraft, ts: number) => {
    if (!pendingFocus) return
    if (ts - pendingFocus.at > FOCUS_FOLD_MS) {
      pendingFocus = null
      return
    }
    const sameTarget =
      (!!draft.elementLabel && draft.elementLabel === pendingFocus.label) ||
      (!!draft.elementRole && draft.elementRole === pendingFocus.role)
    if (!sameTarget && draft.category !== 'input' && draft.category !== 'submission') {
      pendingFocus = null
      return
    }
    const focusDraft = drafts[pendingFocus.draftIndex]
    if (focusDraft && (focusDraft.category === 'interaction' || focusDraft.l1Op === 'fill_field')) {
      for (const id of focusDraft.sourceEventIds) {
        if (!draft.sourceEventIds.includes(id)) draft.sourceEventIds.push(id)
      }
      if (!draft.elementLabel && focusDraft.elementLabel) draft.elementLabel = focusDraft.elementLabel
      if (!draft.elementRole && focusDraft.elementRole) draft.elementRole = focusDraft.elementRole
      drafts.splice(pendingFocus.draftIndex, 1)
      adjustPendingFocusAfterSplice(pendingFocus.draftIndex)
    }
    pendingFocus = null
  }

  const noteScreen = (event: TelemetryEvent) => {
    const id = event.screenStateId
    if (!id) return
    const delta: ScreenAfterDelta = {
      appName: event.data?.appName,
      documentTitle: event.data?.documentTitle || event.data?.windowTitle,
      urlHost: urlHostFromEvent(event)
    }
    // Attach after-state to the most recent non-session action.
    for (let i = drafts.length - 1; i >= 0; i--) {
      const prior = drafts[i]
      if (prior.category === 'session' || prior.category === 'idle') continue
      if (!prior.screenAfterId) {
        prior.screenAfterId = id
        prior.screenAfter = changedOnly(lastScreenDelta, delta)
      }
      break
    }
    lastScreenId = id
    lastScreenDelta = delta
  }

  const attachStateChange = (event: TelemetryEvent) => {
    const kind = event.data?.stateChangeKind
    const detail = event.data?.stateChangeDetail
    for (let i = drafts.length - 1; i >= 0; i--) {
      const prior = drafts[i]
      if (prior.category === 'session' || prior.category === 'idle') continue
      if (!prior.sourceEventIds.includes(event.eventId)) {
        prior.sourceEventIds.push(event.eventId)
      }
      prior.screenAfter = {
        ...(prior.screenAfter ?? {}),
        ...(kind ? { stateChangeKind: kind } : {}),
        ...(detail ? { stateChangeDetail: detail } : {})
      }
      if (event.screenStateId && !prior.screenAfterId) {
        prior.screenAfterId = event.screenStateId
      }
      break
    }
    if (event.screenStateId) noteScreen(event)
  }

  const pushNavigation = (event: TelemetryEvent, kind: 'navigation' | 'app_switch' | 'window_switch') => {
    if (event.data?.userInitiated === false) {
      // Keep screen context without emitting a polished navigation row.
      if (event.screenStateId) noteScreen(event)
      return
    }
    lastNav = event
    const doc = event.data?.documentTitle || event.data?.windowTitle
    const app = event.data?.appName
    const label = doc || app || event.page || 'a page'
    const docKey = `${app ?? ''}|${doc ?? ''}`
    if (docKey && docKey === lastDocKey && drafts.length > 0) {
      const prior = drafts[drafts.length - 1]
      if (prior.category === 'navigation') {
        if (!prior.sourceEventIds.includes(event.eventId)) {
          prior.sourceEventIds.push(event.eventId)
        }
        if (event.screenStateId) {
          prior.screenAfterId = event.screenStateId
          lastScreenId = event.screenStateId
          lastScreenDelta = {
            appName: app,
            documentTitle: doc,
            urlHost: urlHostFromEvent(event)
          }
        }
        return
      }
    }
    lastDocKey = docKey
    const verb =
      kind === 'app_switch' ? 'Switched to' : kind === 'window_switch' ? 'Opened window' : 'Opened'
    const text =
      kind === 'window_switch'
        ? doc && app
          ? `Opened window ${doc} in ${app}`
          : `Opened window ${label}`
        : doc && app
          ? `${verb} ${doc} in ${app}`
          : `${verb} ${label}`
    const draft: ActionDraft = {
      text,
      category: 'navigation',
      timestamp: event.timestamp,
      sourceEventIds: [event.eventId],
      appName: app,
      documentTitle: doc,
      userInitiated: event.data?.userInitiated,
      screenBeforeId: lastScreenId,
      screenAfterId: event.screenStateId,
      screenAfter: event.screenStateId
        ? changedOnly(lastScreenDelta, {
            appName: app,
            documentTitle: doc,
            urlHost: urlHostFromEvent(event)
          })
        : undefined
    }
    push(draft)
    if (event.screenStateId) {
      lastScreenId = event.screenStateId
      lastScreenDelta = {
        appName: app,
        documentTitle: doc,
        urlHost: urlHostFromEvent(event)
      }
    }
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const ts = Date.parse(event.timestamp)
    if (lastTs && ts - lastTs >= IDLE_GAP_MS) {
      // Preserve wait semantics on the next real action instead of a dropped idle row.
      pendingWaitMs += ts - lastTs
    }
    lastTs = ts || lastTs

    switch (event.type) {
      case 'session_started':
        push({
          text: 'Started recording',
          category: 'session',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId]
        })
        break
      case 'session_stopped':
        push({
          text: 'Stopped recording',
          category: 'session',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId]
        })
        break
      case 'navigation':
        pushNavigation(event, 'navigation')
        break
      case 'app_switch':
        pushNavigation(event, 'app_switch')
        break
      case 'window_switch':
        pushNavigation(event, 'window_switch')
        break
      case 'screen_changed': {
        const doc = event.data?.documentTitle || event.data?.windowTitle
        const app = event.data?.appName
        const docKey = `${app ?? ''}|${doc ?? ''}`
        noteScreen(event)
        if (lastNav && sameScreen(lastNav, event)) {
          lastNav = null
          const prior = drafts[drafts.length - 1]
          if (prior && doc && !prior.documentTitle) prior.documentTitle = doc
          break
        }
        if (docKey && docKey === lastDocKey) {
          // Collapse repeated screen_changed within the same document.
          break
        }
        if (event.data?.userInitiated === false) {
          break
        }
        lastDocKey = docKey
        if (doc || event.page || app) {
          const text =
            doc && app ? `Viewing ${doc} in ${app}` : `Screen changed to ${doc || event.page || app}`
          push({
            text,
            category: 'navigation',
            timestamp: event.timestamp,
            sourceEventIds: [event.eventId],
            appName: app,
            documentTitle: doc,
            userInitiated: event.data?.userInitiated,
            screenAfterId: event.screenStateId,
            screenAfter: {
              appName: app,
              documentTitle: doc,
              urlHost: urlHostFromEvent(event)
            }
          })
        }
        if (event.data?.errorState || (event.data?.dialogs && event.data.dialogs.length)) {
          push({
            text: `Encountered ${event.data.errorState || event.data.dialogs![0]}`,
            category: 'error',
            timestamp: event.timestamp,
            sourceEventIds: [event.eventId],
            appName: app,
            documentTitle: doc
          })
        }
        break
      }
      case 'state_change':
        attachStateChange(event)
        break
      case 'focus_changed': {
        const label =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        const role = event.data?.elementRole || event.target?.role
        if (!label && !role) break
        const draft: ActionDraft = {
          text: label ? `Focused ${label}` : `Focused ${role}`,
          category: 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: role,
          targetResolution: resolveTargetResolution({ role, label }),
          inputKind: classifyInputKind(undefined, {
            fieldLabel: label,
            fieldType: event.data?.field?.fieldType || event.target?.fieldType,
            elementRole: role
          }),
          elementBounds: event.data?.elementBounds
        }
        push(draft)
        pendingFocus = {
          draftIndex: drafts.length - 1,
          at: ts,
          label,
          role
        }
        break
      }
      case 'text_input': {
        const typed = event.data?.typedText
        const label =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        const role = event.data?.elementRole
        const inputKind = classifyInputKind(typed, {
          fieldLabel: label,
          fieldType: event.data?.field?.fieldType || event.target?.fieldType,
          elementRole: role
        })
        const submitKey = event.data?.submitKey
        const isTabOnly = !typed && submitKey === 'Tab'

        // Tab after a fill_field / typed input on the same target → fold in.
        if (isTabOnly) {
          const prior = drafts[drafts.length - 1]
          if (
            prior &&
            (prior.l1Op === 'fill_field' || prior.category === 'input') &&
            ((!label && !prior.elementLabel) || label === prior.elementLabel) &&
            ts - Date.parse(prior.timestamp) < FOCUS_FOLD_MS
          ) {
            if (!prior.sourceEventIds.includes(event.eventId)) {
              prior.sourceEventIds.push(event.eventId)
            }
            prior.l1Op = 'fill_field'
            break
          }
          const draft: ActionDraft = {
            text: label ? `Pressed Tab in ${label}` : 'Pressed Tab',
            category: 'input',
            timestamp: event.timestamp,
            sourceEventIds: [event.eventId],
            appName: event.data?.appName,
            documentTitle: event.data?.documentTitle,
            elementLabel: label,
            elementRole: role,
            inputKind,
            targetResolution: resolveTargetResolution({ role, label })
          }
          foldPendingFocus(draft, ts)
          if (draft.sourceEventIds.length > 1 || isTextFieldRole(role)) {
            draft.l1Op = 'fill_field'
          }
          push(draft)
          break
        }

        if (!typed) {
          if (submitKey) {
            const draft: ActionDraft = {
              text: label
                ? `Pressed ${submitKey} in ${label}`
                : `Pressed ${submitKey}`,
              category: 'input',
              timestamp: event.timestamp,
              sourceEventIds: [event.eventId],
              appName: event.data?.appName,
              documentTitle: event.data?.documentTitle,
              elementLabel: label,
              elementRole: role,
              inputKind,
              semanticOp: submitKey === 'Return' || submitKey === 'Enter' ? 'submit' : undefined,
              targetResolution: resolveTargetResolution({ role, label })
            }
            foldPendingFocus(draft, ts)
            push(draft)
          }
          break
        }
        pendingField = event
        const shown = typed.length > 120 ? `${typed.slice(0, 119)}…` : typed
        const draft: ActionDraft = {
          text: label ? `Typed "${shown}" into ${label}` : `Typed "${shown}"`,
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: role,
          typedText: shown,
          inputKind,
          semanticOp:
            submitKey === 'Return' || submitKey === 'Enter' ? 'submit' : undefined,
          targetResolution: resolveTargetResolution({ role, label }),
          elementBounds: event.data?.elementBounds
        }
        foldPendingFocus(draft, ts)

        // Fold a preceding click on the same text field into this fill.
        const prior = drafts[drafts.length - 1]
        if (
          prior &&
          prior.category === 'interaction' &&
          isTextFieldRole(prior.elementRole) &&
          ((!label && !prior.elementLabel) || label === prior.elementLabel) &&
          ts - Date.parse(prior.timestamp) < FOCUS_FOLD_MS
        ) {
          for (const id of prior.sourceEventIds) {
            if (!draft.sourceEventIds.includes(id)) draft.sourceEventIds.push(id)
          }
          if (!draft.elementLabel && prior.elementLabel) draft.elementLabel = prior.elementLabel
          if (!draft.elementRole && prior.elementRole) draft.elementRole = prior.elementRole
          drafts.pop()
        }

        // fill_field only when a preceding click/focus was folded in, or Tab ended entry.
        if (draft.sourceEventIds.length > 1 || submitKey === 'Tab') {
          draft.l1Op = 'fill_field'
        }
        push(draft)
        break
      }
      case 'click':
      case 'element_activated': {
        const key = targetKey(event)
        if (key && key === lastClickKey && ts - lastClickAt < CLICK_COLLAPSE_MS) {
          const prior = drafts[drafts.length - 1]
          if (prior && !prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          lastClickAt = ts
          break
        }
        lastClickKey = key
        lastClickAt = ts
        const axLabel =
          event.data?.elementLabel ||
          event.target?.visibleLabel ||
          event.target?.accessibleLabel ||
          event.target?.analyticsId
        const resolution = resolveTarget(event, axLabel)
        const name =
          axLabel ||
          (resolution === 'coords'
            ? `point (${event.data?.clickX},${event.data?.clickY})`
            : null)
        // Do not invent "a control" when nothing was resolved.
        if (!name && resolution === 'none') break

        const displayName = name || 'unresolved target'
        const isSend = /^(send|submit|share|post|done)$/i.test((axLabel ?? '').trim())
        const inferred = event.data?.inferred === true || event.type === 'element_activated'
        const role = event.data?.elementRole || event.target?.role

        if (isSend && pendingPaste && ts - pendingPaste.at < PASTE_CHAIN_MS) {
          // Drop the intermediate transfer/paste row — submission supersedes it.
          removeDraftContainingEvent(pendingPaste.event.eventId)
          if (pendingClipboard) {
            removeDraftContainingEvent(pendingClipboard.event.eventId)
          }
          const sources = [
            ...(pendingClipboard ? [pendingClipboard.event.eventId] : []),
            pendingPaste.event.eventId,
            event.eventId
          ]
          const verified = detectVerified(events, i)
          const clip = pendingClipboard?.clip
          const host = clip?.urlHost
          const draft: ActionDraft = {
            text: host
              ? `Pasted and sent ${host} link`
              : 'Pasted clipboard content and sent',
            category: 'submission',
            timestamp: pendingPaste.event.timestamp,
            sourceEventIds: sources,
            appName: event.data?.appName,
            documentTitle: event.data?.documentTitle,
            elementLabel: axLabel ?? displayName,
            elementRole: role,
            clipboard: clip,
            clipboardPairId: pendingPaste.pairId ?? pendingClipboard?.pairId,
            transferSourceLabel: pendingPaste.transferSourceLabel,
            transferDestLabel: pendingPaste.transferDestLabel,
            inferred,
            verified,
            targetResolution: resolution,
            semanticOp: 'submit',
            l1Op: 'transfer',
            clickButton: event.data?.clickButton,
            clickCount: event.data?.clickCount,
            clickX: event.data?.clickX,
            clickY: event.data?.clickY,
            clickWindowX: event.data?.clickWindowX,
            clickWindowY: event.data?.clickWindowY,
            windowWidth: event.data?.windowBounds?.width,
            windowHeight: event.data?.windowBounds?.height,
            elementBounds: event.data?.elementBounds
          }
          foldPendingFocus(draft, ts)
          push(draft)
          pendingClipboard = null
          pendingPaste = null
          break
        }

        const verb = isSend ? 'Activated' : event.type === 'click' ? 'Clicked' : 'Selected'
        const draft: ActionDraft = {
          text: `${verb} ${displayName}`,
          category: isSend ? 'submission' : 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: axLabel ?? undefined,
          elementRole: role,
          inferred: inferred || undefined,
          verified: isSend ? detectVerified(events, i) : undefined,
          clickButton: event.data?.clickButton,
          clickCount: event.data?.clickCount,
          clickX: event.data?.clickX,
          clickY: event.data?.clickY,
          clickWindowX: event.data?.clickWindowX,
          clickWindowY: event.data?.clickWindowY,
          windowWidth: event.data?.windowBounds?.width,
          windowHeight: event.data?.windowBounds?.height,
          targetResolution: resolution,
          semanticOp: isSend ? 'submit' : undefined,
          elementBounds: event.data?.elementBounds,
          listContext: event.data?.listContext || event.target?.listContext,
          clickModifiers: event.data?.clickModifiers,
          elementNorm: event.data?.elementNorm
        }
        foldPendingFocus(draft, ts)
        push(draft)

        // Text-field clicks are candidates for fill_field merge with following typing.
        if (!isSend && isTextFieldRole(role)) {
          pendingFocus = {
            draftIndex: drafts.length - 1,
            at: ts,
            label: axLabel ?? undefined,
            role
          }
        }
        break
      }
      case 'field_completed': {
        pendingField = event
        const label =
          event.data?.field?.label ||
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel ||
          'a field'
        push({
          text: `Completed the ${label} field`,
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: event.data?.elementRole,
          inputKind: classifyInputKind(undefined, {
            fieldLabel: label,
            fieldType: event.data?.field?.fieldType,
            elementRole: event.data?.elementRole
          }),
          targetResolution: 'ax'
        })
        break
      }
      case 'form_submitted': {
        const sources = pendingField
          ? [pendingField.eventId, event.eventId]
          : [event.eventId]
        const form =
          event.data?.formLabel || event.target?.formLabel || 'the form'
        push({
          text: `Submitted ${form}`,
          category: 'submission',
          timestamp: event.timestamp,
          sourceEventIds: sources,
          appName: event.data?.appName,
          verified: detectVerified(events, i),
          semanticOp: 'submit'
        })
        pendingField = null
        break
      }
      case 'selection_changed': {
        const label =
          event.data?.selectionLabel ||
          event.data?.selectedLabels?.[0] ||
          event.target?.visibleLabel ||
          'a selection'
        push({
          text: `Changed selection to ${label}`,
          category: 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          targetResolution: 'ax'
        })
        break
      }
      case 'clipboard_changed': {
        const clip = event.data?.clipboard
        if (!clip) break
        const sourceLabel =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        const pairId = event.data?.clipboardPairId || clip.pairId
        pendingClipboard = {
          event,
          clip,
          at: ts,
          pairId,
          sourceLabel
        }
        const desc =
          clip.contentType === 'url' && clip.urlHost
            ? `Copied ${clip.urlHost} link`
            : `Copied ${clip.contentType} to clipboard`
        push({
          text: desc,
          category: 'clipboard',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: sourceLabel,
          elementRole: event.data?.elementRole || event.target?.role,
          clipboard: clip,
          clipboardPairId: pairId,
          transferSourceLabel: sourceLabel,
          semanticOp: 'copy'
        })
        break
      }
      case 'paste_detected': {
        const destLabel =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        const pairId =
          event.data?.clipboardPairId ||
          event.data?.clipboard?.pairId ||
          pendingClipboard?.pairId
        const hashMatch =
          !!pendingClipboard &&
          !!event.data?.matchedClipboardHash &&
          event.data.matchedClipboardHash === pendingClipboard.clip.contentHash &&
          ts - pendingClipboard.at < PASTE_CHAIN_MS
        const pairMatch =
          !!pendingClipboard &&
          !!pairId &&
          (pairId === pendingClipboard.pairId ||
            pairId === pendingClipboard.clip.pairId)
        const matched = pairMatch || hashMatch

        if (matched && pendingClipboard) {
          removeDraftContainingEvent(pendingClipboard.event.eventId)
          const host = event.data?.clipboard?.urlHost || pendingClipboard.clip.urlHost
          const sourceLabel = pendingClipboard.sourceLabel
          const draft: ActionDraft = {
            text: host
              ? `Transferred ${host} link${sourceLabel && destLabel ? ` from ${sourceLabel} to ${destLabel}` : destLabel ? ` to ${destLabel}` : ''}`
              : sourceLabel && destLabel
                ? `Transferred from ${sourceLabel} to ${destLabel}`
                : 'Transferred clipboard content',
            category: 'clipboard',
            timestamp: event.timestamp,
            sourceEventIds: [pendingClipboard.event.eventId, event.eventId],
            appName: event.data?.appName,
            documentTitle: event.data?.documentTitle,
            elementLabel: destLabel,
            elementRole: event.data?.elementRole || event.target?.role,
            clipboard: event.data?.clipboard || pendingClipboard.clip,
            clipboardPairId: pairId,
            transferSourceLabel: sourceLabel,
            transferDestLabel: destLabel,
            inferred: event.data?.inferred,
            semanticOp: 'paste',
            l1Op: 'transfer',
            targetResolution: destLabel || event.data?.elementRole ? 'ax' : 'none'
          }
          foldPendingFocus(draft, ts)
          push(draft)
          pendingPaste = {
            event,
            at: ts,
            pairId,
            transferSourceLabel: sourceLabel,
            transferDestLabel: destLabel
          }
          break
        }

        pendingPaste = {
          event,
          at: ts,
          pairId,
          transferDestLabel: destLabel,
          transferSourceLabel: pendingClipboard?.sourceLabel
        }
        const host = event.data?.clipboard?.urlHost || pendingClipboard?.clip.urlHost
        const draft: ActionDraft = {
          text: host ? `Pasted ${host} link` : 'Pasted clipboard content',
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [
            ...(pendingClipboard ? [pendingClipboard.event.eventId] : []),
            event.eventId
          ],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: destLabel,
          clipboard: event.data?.clipboard || pendingClipboard?.clip,
          clipboardPairId: pairId,
          transferSourceLabel: pendingClipboard?.sourceLabel,
          transferDestLabel: destLabel,
          inferred: true,
          semanticOp: 'paste',
          targetResolution: destLabel || event.data?.elementRole ? 'ax' : 'none'
        }
        foldPendingFocus(draft, ts)
        push(draft)
        break
      }
      case 'scroll': {
        const containerRole = event.data?.scrollContainerRole
        const containerLabel = event.data?.scrollContainerLabel
        const containerKey = `${containerRole ?? ''}|${containerLabel ?? ''}`
        const prior = drafts[drafts.length - 1]
        const priorKey =
          prior?.l1Op === 'reveal'
            ? `${prior.elementRole ?? ''}|${prior.elementLabel ?? ''}`
            : null
        if (
          prior &&
          prior.l1Op === 'reveal' &&
          priorKey === containerKey &&
          (prior.appName ?? '') === (event.data?.appName ?? '')
        ) {
          if (!prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          // Keep the latest scroll position semantics in the text.
          const label = containerLabel || containerRole
          prior.text = label ? `Scrolled ${label}` : 'Scrolled'
          if (typeof event.data?.scrollDelta === 'number') {
            prior.scrollDelta = (prior.scrollDelta ?? 0) + event.data.scrollDelta
          }
          if (event.data?.scrollAxis) prior.scrollAxis = event.data.scrollAxis
          break
        }
        const label = containerLabel || containerRole
        push({
          text: label ? `Scrolled ${label}` : 'Scrolled',
          category: 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: containerLabel,
          elementRole: containerRole,
          l1Op: 'reveal',
          targetResolution: resolveTargetResolution({
            role: containerRole,
            label: containerLabel,
            clickX: event.data?.clickX,
            clickY: event.data?.clickY
          }),
          clickX: event.data?.clickX,
          clickY: event.data?.clickY,
          clickWindowX: event.data?.clickWindowX,
          clickWindowY: event.data?.clickWindowY,
          windowWidth: event.data?.windowBounds?.width,
          windowHeight: event.data?.windowBounds?.height,
          scrollAxis: event.data?.scrollAxis,
          scrollDelta: event.data?.scrollDelta
        })
        break
      }
      case 'keyboard_shortcut':
      case 'key_pressed': {
        const shortcut = event.data?.shortcut || 'a shortcut'
        const semanticOp =
          event.type === 'keyboard_shortcut' ? semanticOpFromShortcut(shortcut) : undefined
        // Collapse long arrow runs into one action with a repeat count in the text.
        const prior = drafts[drafts.length - 1]
        if (
          event.type === 'key_pressed' &&
          prior?.category === 'shortcut' &&
          prior.text.startsWith(`Pressed ${shortcut}`) &&
          (prior.appName ?? '') === (event.data?.appName ?? '') &&
          /^(Up|Down|Left|Right)$/i.test(shortcut)
        ) {
          if (!prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          const n = prior.sourceEventIds.length
          prior.text = n > 1 ? `Pressed ${shortcut} ×${n}` : `Pressed ${shortcut}`
          break
        }
        push({
          text:
            event.type === 'key_pressed' ? `Pressed ${shortcut}` : `Used shortcut ${shortcut}`,
          category: 'shortcut',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          semanticOp
        })
        break
      }
      case 'keyframe_captured':
        if (event.data?.keyframePath && drafts.length > 0) {
          const prior = drafts[drafts.length - 1]
          if (prior.category !== 'session' && prior.category !== 'idle') {
            prior.keyframePath = event.data.keyframePath
            if (!prior.sourceEventIds.includes(event.eventId)) {
              prior.sourceEventIds.push(event.eventId)
            }
          }
        }
        break
      case 'error': {
        const msg = event.data?.message || event.data?.errorState || 'an error'
        push({
          text: `Encountered ${msg}`,
          category: 'error',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName
        })
        break
      }
      case 'narration_span': {
        const text = event.data?.narrationText
        if (!text || drafts.length === 0) break
        for (let j = drafts.length - 1; j >= 0; j--) {
          const prior = drafts[j]
          if (prior.category === 'session' || prior.category === 'idle') continue
          prior.narrationText = text
          if (!prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          break
        }
        break
      }
      case 'marker': {
        const marker = event.data?.marker
        if (!marker || drafts.length === 0) break
        for (let j = drafts.length - 1; j >= 0; j--) {
          const prior = drafts[j]
          if (prior.category === 'session' || prior.category === 'idle') continue
          prior.marker = marker
          if (!prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          break
        }
        break
      }
      default:
        break
    }
  }

  const actions: PolishedAction[] = drafts.map((d, i) => ({
    ...d,
    order: i + 1
  }))

  const { segments, screens } = segmentActions(actions)

  const sequenceRange = {
    min: events.length ? events[0].sequence : 0,
    max: events.length ? events[events.length - 1].sequence : 0
  }

  let polished: PolishedSession = {
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    polishedAt: new Date().toISOString(),
    sequenceRange,
    actions,
    segments,
    screens
  }

  // Overlap-based narration attachment (events may already have folded markers).
  if (store.getNarration) {
    try {
      const narration = await store.getNarration(sessionId)
      if (narration?.spans?.length) {
        const meta = await store.getSessionMeta(sessionId)
        const startedAtMs = meta ? Date.parse(meta.startedAt) : 0
        if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
          polished = attachNarration(
            polished,
            narration.spans.map((s) => ({
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
              ...(s.marker ? { marker: s.marker } : {})
            })),
            startedAtMs
          )
        }
      }
    } catch (err) {
      console.error(
        '[telemetry] attachNarration failed',
        err instanceof Error ? err.name : 'error'
      )
    }
  }

  await store.savePolishedSession(sessionId, polished)
  return polished
}

function isTextFieldRole(role: string | undefined): boolean {
  return !!role && TEXT_FIELD_ROLES.has(role)
}

function resolveTarget(event: TelemetryEvent, axLabel: string | undefined): TargetResolution {
  return resolveTargetResolution({
    role: event.data?.elementRole || event.target?.role,
    label: axLabel,
    clickX: event.data?.clickX,
    clickY: event.data?.clickY
  })
}

function changedOnly(
  before: ScreenAfterDelta | undefined,
  after: ScreenAfterDelta
): ScreenAfterDelta | undefined {
  const delta: ScreenAfterDelta = {}
  if (after.appName && after.appName !== before?.appName) delta.appName = after.appName
  if (after.documentTitle && after.documentTitle !== before?.documentTitle) {
    delta.documentTitle = after.documentTitle
  }
  if (after.urlHost && after.urlHost !== before?.urlHost) delta.urlHost = after.urlHost
  return Object.keys(delta).length ? delta : undefined
}

function targetKey(event: TelemetryEvent): string | null {
  const t = event.target
  const d = event.data
  if (!t && !d?.elementLabel) return null
  return [
    t?.analyticsId,
    d?.elementRole || t?.role,
    t?.tagName,
    d?.elementLabel || t?.visibleLabel || t?.accessibleLabel,
    t?.appName || d?.appName
  ]
    .filter(Boolean)
    .join('|')
}

function sameScreen(a: TelemetryEvent, b: TelemetryEvent): boolean {
  if (a.screenStateId && b.screenStateId) return a.screenStateId === b.screenStateId
  return (
    (a.data?.documentTitle || a.data?.windowTitle) ===
      (b.data?.documentTitle || b.data?.windowTitle) &&
    a.data?.appName === b.data?.appName &&
    a.data?.urlHost === b.data?.urlHost
  )
}

/** Look ahead briefly for corroborating state after a submit/send. */
function detectVerified(events: TelemetryEvent[], index: number): boolean {
  const base = events[index]
  const baseTs = Date.parse(base.timestamp)
  for (let j = index + 1; j < Math.min(events.length, index + 6); j++) {
    const e = events[j]
    const ts = Date.parse(e.timestamp)
    if (ts - baseTs > 4000) break
    if (
      e.type === 'focus_changed' &&
      e.data?.field?.valueLength === 0 &&
      e.data?.appName === base.data?.appName
    ) {
      return true
    }
    if (e.type === 'selection_changed' && e.data?.appName === base.data?.appName) {
      return true
    }
    if (e.type === 'screen_changed' && e.data?.successMessage) {
      return true
    }
    if (e.type === 'state_change' && e.data?.stateChangeKind === 'toast_appeared') {
      return true
    }
    if (e.data?.verified === true) return true
  }
  const label = base.data?.elementLabel || base.target?.visibleLabel || ''
  if (/^(send|share|post)$/i.test(label.trim())) return true
  return false
}
