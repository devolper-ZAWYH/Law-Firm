/**
 * pdfjs-dist ships its worker as a bare .mjs with no type declaration, and it
 * is imported for its SIDE EFFECT only — loading it is what registers the
 * worker that pdfjs then finds, which is the supported way to run pdfjs in
 * Node (see lib/platform/paylaterPdf.ts).
 *
 * There is no API to describe here, so the module is declared empty rather than
 * typed as `any`: nothing should be reading anything off it.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
