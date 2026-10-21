// The app icon's grove without its tile, drawn on a 16px grid for the title bar.
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M2 10h2v3H2zM7 10h2v3H7zM12 10h2v3h-2z" fill="currentColor" opacity="0.45" />
      <rect x="1" y="13" width="14" height="2" rx="1" fill="currentColor" opacity="0.3" />
      <rect x="1" y="13" width="10" height="2" rx="1" fill="#3b86f2" />
      <g fill="#3b86f2">
        <rect x="1.5" y="5" width="3" height="2" rx="0.5" />
        <rect x="0.5" y="6" width="5" height="3.5" rx="0.5" />
        <rect x="1.5" y="8" width="3" height="3" rx="0.5" />
      </g>
      <g fill="#1ba598">
        <rect x="6.5" y="1.5" width="3" height="2" rx="0.5" />
        <rect x="5.5" y="2.5" width="5" height="7" rx="0.5" />
        <rect x="6.5" y="8" width="3" height="3" rx="0.5" />
      </g>
      <g fill="#22bf78">
        <rect x="11.5" y="3.5" width="3" height="2" rx="0.5" />
        <rect x="10.5" y="4.5" width="5" height="5" rx="0.5" />
        <rect x="11.5" y="8" width="3" height="3" rx="0.5" />
      </g>
    </svg>
  )
}
