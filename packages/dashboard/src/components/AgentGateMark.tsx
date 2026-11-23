export function AgentGateMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-[var(--text)]"
    >
      <path
        d="M4 20V10C4 5.58 7.58 2 12 2C16.42 2 20 5.58 20 10V20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M8.5 20V11C8.5 9.07 10.07 7.5 12 7.5C13.93 7.5 15.5 9.07 15.5 11V20"
        stroke="var(--accent)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <line x1="2" y1="20" x2="22" y2="20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.75" fill="var(--accent)" />
    </svg>
  );
}
