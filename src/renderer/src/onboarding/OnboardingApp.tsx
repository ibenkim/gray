import { useEffect, useRef, useState } from 'react'
import type { OnboardingStep, PermissionsState, Session, Team } from '../state/types'
import WelcomeStep from './WelcomeStep'
import TeamStep from './TeamStep'
import PermissionsStep from './PermissionsStep'

const UNKNOWN_PERMS: PermissionsState = {
  screen: 'unknown',
  accessibility: 'unknown',
  microphone: 'unknown'
}

/** Transparent pad so the card shadow isn't clipped by the window bounds. */
const ONB_SHADOW_PAD = 36

/**
 * Onboarding overlay root — a hard gate (no dismiss; quit only via tray).
 * Step progress lives in the shared store so relaunch resumes the same card;
 * this component simply mirrors it and routes to the matching step.
 * The window hugs the card via setOnboardingSize so it stays movable and
 * non-blocking over the desktop.
 */
export default function OnboardingApp() {
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [session, setSession] = useState<Session>(null)
  const [micSkipped, setMicSkipped] = useState(false)
  const [permissions, setPermissions] = useState<PermissionsState>(UNKNOWN_PERMS)
  const [pendingInvite, setPendingInvite] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.ghostBridge?.getSnapshot?.().then((snap) => {
      if (cancelled || !snap) return
      setStep(snap.onboardingStep)
      setSession(snap.session)
      setMicSkipped(snap.micSkipped)
    })
    window.ghostBridge?.getPermissions?.().then((p) => {
      if (!cancelled && p) setPermissions(p)
    })

    const offStore = window.ghostBridge?.onStoreChanged?.((snap) => {
      setStep(snap.onboardingStep)
      setSession(snap.session)
      setMicSkipped(snap.micSkipped)
    })
    const offPerms = window.ghostBridge?.onPermissionsChanged?.((p) => setPermissions(p))
    const offLink = window.ghostBridge?.onDeepLink?.((link) => {
      // Arrived via an invite link: pre-fill Join. Magic / Google links advance
      // the step in main, which propagates back through the store subscription.
      if (link.kind === 'invite') setPendingInvite(link.code)
    })

    return () => {
      cancelled = true
      offStore?.()
      offPerms?.()
      offLink?.()
    }
  }, [])

  // Hug the live card so shadow has room and step height changes resize the window.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const card = root.querySelector('.onb-card') as HTMLElement | null
    if (!card) return

    function report() {
      const el = rootRef.current?.querySelector('.onb-card') as HTMLElement | null
      if (!el) return
      const w = Math.ceil(el.offsetWidth) + ONB_SHADOW_PAD * 2
      const h = Math.ceil(el.offsetHeight) + ONB_SHADOW_PAD * 2
      window.ghostBridge?.setOnboardingSize?.(w, h)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(card)
    return () => observer.disconnect()
  }, [step, permissions, micSkipped, pendingInvite, session])

  return (
    <div className="onb-root" ref={rootRef}>
      {step === 'welcome' && <WelcomeStep session={session} />}
      {step === 'team' && (
        <TeamStep
          session={session}
          pendingInvite={pendingInvite}
          onBack={() => window.ghostBridge?.setOnboardingStep?.('welcome')}
        />
      )}
      {(step === 'permissions' || step === 'complete') && (
        <PermissionsStep permissions={permissions} micSkipped={micSkipped} />
      )}
    </div>
  )
}
