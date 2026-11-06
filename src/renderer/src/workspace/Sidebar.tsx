import { useRef, useState } from 'react'
import { WorkspacePopover } from './WorkspacePopover'
import type { Team } from '../state/types'
import type { Space, WorkspaceNav } from './WorkspaceApp'

/**
 * Sidebar (Figma: sidebar · team-menu): traffic lights, the workspace switcher and nav.
 * The selected-row fill slides between nav items instead of jumping.
 */
export default function Sidebar({
  nav,
  onNav,
  space,
  onSpace,
  team,
  isOwner
}: {
  nav: WorkspaceNav
  onNav: (n: WorkspaceNav) => void
  space: Space
  onSpace: (s: Space) => void
  team: Team
  isOwner: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  /** The switcher button: the team menu is anchored to it in the card's overlay layer. */
  const buttonRef = useRef<HTMLButtonElement>(null)
  const teamName = team?.name ?? "Harry's team"
  const spaces: Space[] = ['Personal', teamName]
  const hasTeam = Boolean(team)

  const switcherLabel = space === 'Personal' ? 'Personal' : teamName

  const items: { id: WorkspaceNav; label: string }[] = [
    { id: 'workflows', label: 'Workflows' },
    { id: 'activity', label: 'Activity' },
    ...(hasTeam ? [{ id: 'shared' as const, label: 'Shared' }] : []),
    ...(hasTeam ? [{ id: 'teams' as const, label: isOwner ? 'Manage' : 'Team' }] : [])
  ]
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.id === nav)
  )

  return (
    <aside className="ws-sidebar">
      <div className="traffic-lights">
        <button
          className="light light-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.grayBridge?.closeWindow?.()}
          title="Close"
          aria-label="Close"
        />
        <button
          className="light light-min"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.grayBridge?.minimizeWindow?.()}
          title="Minimize"
          aria-label="Minimize"
        />
        <span className="light light-zoom" />
      </div>

      <div className="team-menu-wrap">
        <button
          ref={buttonRef}
          className="team-menu-btn"
          title={isOwner && space !== 'Personal' ? `${teamName} · Owner` : switcherLabel}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="team-avatar" />
          <span className="team-name">{switcherLabel}</span>
          <span className="team-chevron">
            <ChevronTiny />
          </span>
        </button>
        {menuOpen && (
          <WorkspacePopover
            anchor={buttonRef.current}
            onClose={() => setMenuOpen(false)}
            className="team-menu"
            align="left"
            matchAnchorWidth
          >
            {spaces.map((s) => (
              <button
                key={s}
                className={`team-menu-item ${space === s ? 'team-menu-item-active' : ''}`}
                onClick={() => {
                  onSpace(s)
                  setMenuOpen(false)
                }}
              >
                <span>{s}</span>
                {space === s && <CheckTiny />}
              </button>
            ))}
            <div className="team-menu-divider" />
            <button className="team-menu-item team-menu-item-dim">Join a team</button>
            <div className="team-menu-divider" />
            <button className="team-menu-item team-menu-item-dim">Settings</button>
            <button
              className="team-menu-item team-menu-item-danger"
              onClick={() => {
                setMenuOpen(false)
                void window.grayBridge?.logout?.()
              }}
            >
              Log out
            </button>
          </WorkspacePopover>
        )}
      </div>

      <nav className="ws-nav">
        <span
          className="ws-nav-indicator"
          style={{ transform: `translateY(${activeIndex * 30}px)` }}
          aria-hidden="true"
        />
        {items.map((item) => (
          <button
            key={item.id}
            className={`ws-nav-item ${nav === item.id ? 'ws-nav-active' : ''}`}
            aria-current={nav === item.id ? 'page' : undefined}
            onClick={() => onNav(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}

function ChevronTiny() {
  return (
    <svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M0.5 0.5 3.5 3.5 6.5 0.5" />
    </svg>
  )
}

function CheckTiny() {
  return (
    <svg width="10" height="8" viewBox="0 0 9.74 7.78" fill="none" aria-hidden="true">
      <path d="M0.37 3.68L3.37 7.03L9.37 0.33" stroke="currentColor" />
    </svg>
  )
}
