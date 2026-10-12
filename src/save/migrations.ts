/**
 * Save migrations: MIGRATIONS[v] turns version v data into version v + 1. Version 1 is the
 * first format (M1), so there are none yet.
 */

export type Migration = (data: unknown) => unknown;

export const MIGRATIONS: Readonly<Record<number, Migration>> = {};
