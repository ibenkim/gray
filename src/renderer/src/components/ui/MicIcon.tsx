/** Mic Icon (Figma 885:2776): filled capsule, cradle and stand in the current colour. */
export default function MicIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={(size * 8) / 11.5}
      height={size}
      viewBox="0 0 8 11.5"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M0.5 4.23C0.5 4.23 0.5 8.46 4 8.46C7.5 8.46 7.5 4.23 7.5 4.23" />
      <path
        d="M4 0.35C4.88 0.35 5.59 1.06 5.59 1.94V4.82C5.59 5.71 4.88 6.42 4 6.42C3.12 6.42 2.41 5.71 2.41 4.82V1.94C2.41 1.06 3.12 0.35 4 0.35Z"
        fill="currentColor"
        strokeWidth="0.7"
      />
      <path d="M4 8.46V11M4 11H2.83M4 11H5.17" />
    </svg>
  )
}
