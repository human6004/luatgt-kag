type Props = { size?: number; className?: string };

/** LuậtGT mark: a golden tile carrying a winding road whose S-curve doubles as the legal "§". */
export default function LogoMark({ size = 20, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect width="24" height="24" rx="6.5" fill="var(--color-accent)" />
      <path
        d="M16.5 5.5h-6a3.25 3.25 0 0 0 0 6.5h3a3.25 3.25 0 0 1 0 6.5h-6"
        stroke="var(--color-navy)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 5.5h-6a3.25 3.25 0 0 0 0 6.5h3a3.25 3.25 0 0 1 0 6.5h-6"
        stroke="var(--color-accent)"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeDasharray="1.6 1.9"
      />
    </svg>
  );
}
