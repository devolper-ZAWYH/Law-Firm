// The firm's other websites, as shown by the "Related websites" card in the
// sidebar. Client-safe (no server-only, no I/O).
//
// WHY THIS IS A FILE AND NOT A SETTING
//   It is a handful of the firm's own addresses that change once a year at
//   most. A settings table would mean a screen to edit it, a migration to hold
//   it, an API to read it and a permission to decide who may change it — all so
//   that a two-line edit could be made without a deploy. Editing the array
//   below is the cheaper truth, and it keeps the links in code review where a
//   typo'd URL is caught before anyone clicks it.
//
// TO ADD A SITE: add an entry. `key` only has to be unique. Both labels are
// required — the card is bilingual and a missing Arabic label would render an
// English one mid-sentence in an Arabic sidebar.

export interface RelatedWebsite {
  /** Stable identifier — used as the React key, never shown. */
  key: string;
  /** Absolute URL, including the scheme. Opened in a new tab. */
  href: string;
  labelEn: string;
  labelAr: string;
  /**
   * OPTIONAL one-liner under the label. Omitted for the entries below: they are
   * the government portals the firm files through, everyone here already knows
   * what each one is, and a description invented for a court system is a
   * confident-sounding sentence nobody checked. The address underneath already
   * says which service it is.
   */
  descriptionEn?: string;
  descriptionAr?: string;
}

export const RELATED_WEBSITES: RelatedWebsite[] = [
  {
    key: 'taqadi',
    href: 'https://taqadi.sjc.gov.qa/itc/login',
    labelEn: 'Taqadi',
    labelAr: 'تقاضي',
  },
  {
    key: 'sak-moj',
    href: 'https://eservices.moj.gov.qa/Mojwebsite/Home.aspx',
    labelEn: 'Sak — Ministry of Justice',
    labelAr: 'صك - وزارة العدل',
  },
  {
    key: 'sjc-courts',
    href: 'https://www.sjc.gov.qa/ar',
    labelEn: 'Courts',
    labelAr: 'محاكم',
  },
  {
    key: 'mol',
    href: 'https://esrv-cprd.mol.gov.qa/login',
    labelEn: 'Ministry of Labour',
    labelAr: 'وزارة العمل',
  },
  {
    key: 'moi',
    href: 'https://portal.moi.gov.qa/wps/portal/ar',
    labelEn: 'Ministry of Interior',
    labelAr: 'وزارة الداخلية',
  },
];
