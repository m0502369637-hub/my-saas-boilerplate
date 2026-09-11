// lib/auth.js — onboarding / user upsert.
//
// Every handler that touches money goes through upsertUser first, so a
// users row (and therefore a stars_balance of 0) always exists before any
// credit/debit. Keyed by Telegram user id — integer() is 64-bit SQLite.
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { users } from 'schema';

export async function upsertUser(from) {
  if (!from) return null;
  const firstName = from.first_name ?? from.username ?? 'there';
  const [row] = await db.insert(users)
    .values({ tgId: from.id, username: from.username, firstName })
    .onConflictDoUpdate({
      target: users.tgId,
      set: { username: from.username, firstName },
    })
    .returning()
    .run();
  return row;
}

export async function getUser(tgId) {
  return db.select().from(users).where(eq(users.tgId, tgId)).get();
}
