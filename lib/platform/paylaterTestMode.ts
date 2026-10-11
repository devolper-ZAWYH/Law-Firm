/**
 * ============================================================
 *  TEMPORARY — REMOVE WHEN THE ACCEPTANCE TEST IS FINISHED
 * ============================================================
 *
 * The portal refuses to import a customer whose QID is already on file
 * anywhere in the company, and refuses to delete a batch that holds files.
 * Both rules are right, and neither should change. But together they make the
 * portal impossible to REHEARSE: the only real spreadsheet available is the
 * one already imported, so every row of it comes back "duplicate", and the
 * batch it created cannot be cleared to try again.
 *
 * While this flag is true, and only for someone who is already an admin:
 *
 *   1. the Excel import offers "import duplicates too", which drops the
 *      company-wide QID skip for that one import; and
 *   2. a batch that holds files can be deleted, taking its files with it.
 *
 * Nothing else changes. The duplicate WARNING is still shown, the preview
 * still names every clash, and a normal import still skips them — the option
 * has to be ticked deliberately each time.
 *
 * TURNED OFF on 2026-09-01, once the acceptance test was finished and the
 * rehearsal batch was cleared. Both controls are gone from the screens: the
 * import no longer offers to bring duplicates in, and a batch holding files
 * cannot be deleted at all.
 *
 * The code is left in place rather than deleted, because rehearsing again
 * before go-live is a thing somebody will want to do, and one word here is a
 * cheaper way back than a revert. To remove it entirely, delete this file and
 * the four blocks that import it — they are all marked "paylaterTestMode".
 * No migration and no data shape depends on it.
 */
export const PAYLATER_TEST_MODE = false;
