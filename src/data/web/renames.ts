/**
 * Renamed and deleted node ids (docs/v3 C6 design D24): an id that src/data/web/snapshots/ids.txt
 * lists maps to its new id, or to null when the node is gone and a save's points on it are
 * refunded. V21 (idSnapshotIssues) fails while a listed id is gone from the content without an
 * entry here; C8 maps stored ids through it. An entry stays for good: saves keep old ids.
 */

export const ID_RENAMES: Readonly<Record<string, string | null>> = {};
