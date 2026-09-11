// lib/app_state.js — tiny key/value store for bot-level state.
//
// Used for cross-invocation coordination that is not per-user: sweep
// throttling (lib/sweep.js) and one-time setup like setMyCommands. Values are
// JSON (the json() column encodes automatically).
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { appState } from 'schema';

export async function getState(key) {
  const row = await db.select().from(appState).where(eq(appState.key, key)).get();
  return row?.value ?? null;
}

export async function setState(key, value) {
  await db.insert(appState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value, updatedAt: new Date() },
    })
    .run();
}
