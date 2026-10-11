'use client';

import { useState } from 'react';

// Renders the real firm logo, falling back to the "AB" monogram only if the
// image fails to load — mirrors the login page's markup/behaviour.
export default function LogoMark() {
  const [logoOk, setLogoOk] = useState(true);

  return logoOk ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/albaker-logo.png"
      alt="Ali AlBaker Law Firm"
      width={720}
      height={415}
      onError={() => setLogoOk(false)}
    />
  ) : (
    <div className="fallback" aria-hidden="true">
      AB
    </div>
  );
}
