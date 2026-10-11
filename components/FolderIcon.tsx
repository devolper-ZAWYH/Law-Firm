'use client';

/**
 * A Finder-style folder tinted with a file's status color. As of Phase 5 the
 * `color` prop carries the DERIVED color computed by lib/platform/colorEngine
 * (from the file's open tasks + the company's settings).
 */
export default function FolderIcon({
  color,
  size = 56,
}: {
  color: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      {/* back tab */}
      <path
        d="M6 18a4 4 0 0 1 4-4h14l5 6h20a4 4 0 0 1 4 4v4H6z"
        fill={color}
        opacity="0.75"
      />
      {/* front body */}
      <path
        d="M6 24a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z"
        fill={color}
      />
      {/* subtle top highlight */}
      <path
        d="M6 24a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v3H6z"
        fill="#ffffff"
        opacity="0.18"
      />
    </svg>
  );
}
