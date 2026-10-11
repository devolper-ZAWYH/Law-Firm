/**
 * Google Drive logo — INLINE SVG (no external asset, no npm dependency, so the
 * nonce-based CSP can never block it). The classic flat three-tone Drive mark:
 * a green left face, a yellow right face and a blue bottom band forming the
 * triangular prism. Brand colours: blue #4285F4 / green #34A853 / yellow #FBBC04.
 *
 * Decorative by default (aria-hidden) — the wrapping link carries the label.
 */
export default function GoogleDriveIcon({ size = 26 }: { size?: number }) {
  // The logo's natural aspect ratio (~1.154:1) — height derived so it never
  // distorts regardless of the caller's chosen width.
  const height = Math.round((size * 1249.993) / 1443.061);
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 1443.061 1249.993"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* bottom band — blue */}
      <path
        fill="#4285F4"
        d="M240.525 1249.993l240.492-416.664h962.044l-240.514 416.664z"
      />
      {/* right face — yellow */}
      <path
        fill="#FBBC04"
        d="M962.055 833.329h481.006L962.055 0H481.031z"
      />
      {/* left face — green */}
      <path
        fill="#34A853"
        d="M0 833.329l240.525 416.664 481.014-833.329L481.022 0z"
      />
    </svg>
  );
}
