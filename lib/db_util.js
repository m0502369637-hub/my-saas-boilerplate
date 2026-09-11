// lib/db_util.js — small helpers around the platform's write results.
//
// The exact shape of a plain write's result differs between the SDK doc the
// platform serves ({ rowsAffected, … }) and what older CLI bundles reported
// (a bare array). Guard both so row-count checks never crash.
export function affectedCount(result) {
  if (!result) return 0;
  if (typeof result.rowsAffected === 'number') return result.rowsAffected;
  if (Array.isArray(result)) return result.length;
  return 0;
}
