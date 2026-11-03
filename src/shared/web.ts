/** A folder on the server, as the web build's file browser shows it. */
export interface BrowseResult {
  /** The data folder: the browser cannot go above it. */
  root: string;
  dir: string;
  folders: string[];
  files: { name: string; size: number }[];
}

/**
 * Sent with every call from the page. A page on another site cannot add a header without the
 * browser asking this server first (which it never allows), so it cannot make calls for the user.
 */
export const CALL_HEADER = 'X-One-Take';
