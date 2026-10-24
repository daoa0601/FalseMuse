/** The largest body one backup request carries: a whole small file or one part of a large one. */
export const BACKUP_PART_BYTES = 32 * 1024 * 1024;
/** Only snapshots may be deleted, so a mistake cannot remove the bucket's copy. */
export const SNAPSHOT_PREFIX = "snapshots/";
