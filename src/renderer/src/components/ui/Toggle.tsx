type ToggleProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

/** on-off switch (37×21): ink track with a white knob when on, hairline track when off. */
export default function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      className={`toggle ${checked ? 'toggle-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}
