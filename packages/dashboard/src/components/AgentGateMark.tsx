export function AgentGateMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-[var(--text)]"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="5"
        stroke="var(--accent)"
        strokeWidth="1.8"
      />
      <path
        d="M7.5 16.5V9.5C7.5 8.4 8.4 7.5 9.5 7.5H14.5C15.6 7.5 16.5 8.4 16.5 9.5V16.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12.5" r="2" fill="var(--accent)" />
    </svg>
  );
}
