import { useRef, useState } from 'react'
import { WorkspacePopover } from './WorkspacePopover'
import type { Team } from '../state/types'
import type { Space, WorkspaceNav } from './WorkspaceApp'

/** Sidebar: traffic lights, team-menu (workspace switcher), nav items. */
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

  const switcherLabel =
    space === 'Personal'
      ? 'Personal'
      : isOwner
        ? `Team  ·  Owner`
        : teamName

  return (
    <aside className="ws-sidebar">
      <div className="traffic-lights">
        <button
          className="light light-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.ghostBridge?.closeWindow?.()}
          title="Close"
        />
        <button
          className="light light-min"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.ghostBridge?.minimizeWindow?.()}
          title="Minimize"
        />
        <span className="light light-zoom" />
      </div>

      <div className="team-menu-wrap">
        <button
          ref={buttonRef}
          className="team-menu-btn"
          title={switcherLabel}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="team-avatar" />
          <span className="team-name">{switcherLabel}</span>
          <ChevronTiny />
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
                {s}
              </button>
            ))}
            <div className="team-menu-divider" />
            <button className="team-menu-item team-menu-item-dim">Join a team</button>
            <button className="team-menu-item team-menu-item-dim">Settings</button>
            <button
              className="team-menu-item"
              onClick={() => {
                setMenuOpen(false)
                void window.ghostBridge?.logout?.()
              }}
            >
              Log out
            </button>
          </WorkspacePopover>
        )}
      </div>

      <nav className="ws-nav">
        <button
          className={`ws-nav-item ${nav === 'workflows' ? 'ws-nav-active' : ''}`}
          onClick={() => onNav('workflows')}
        >
          Workflows
        </button>
        <button
          className={`ws-nav-item ${nav === 'activity' ? 'ws-nav-active' : ''}`}
          onClick={() => onNav('activity')}
        >
          Activity
        </button>
        {hasTeam && (
          <>
            <button
              className={`ws-nav-item ${nav === 'shared' ? 'ws-nav-active' : ''}`}
              onClick={() => onNav('shared')}
            >
              Shared
            </button>
            <button
              className={`ws-nav-item ${nav === 'teams' ? 'ws-nav-active' : ''}`}
              onClick={() => onNav('teams')}
            >
              Teams
            </button>
          </>
        )}
      </nav>
    </aside>
  )
}

function ChevronTiny() {
  return (
    <svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M0.5 0.5 3.5 3.5 6.5 0.5" />
    </svg>
  )
}
