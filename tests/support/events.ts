import type { NostrEvent } from "@nostrify/nostrify";

let made = 0;

/** A 64-character hex string made of one repeated digit: a public key or an event id. */
export const hex64 = (digit: string) => digit.repeat(64);

/**
 * An event with the shape of a real one, made of `fields` over defaults: a fresh id each time,
 * a fixed time, no tags, no text. It is not signed; nothing that reads it checks signatures.
 */
export function shapedEvent(fields: Partial<NostrEvent> & Pick<NostrEvent, "kind" | "pubkey">): NostrEvent {
  made += 1;
  return {
    id: made.toString(16).padStart(64, "0"),
    created_at: 1_700_000_000,
    tags: [],
    content: "",
    sig: "f".repeat(128),
    ...fields,
  };
}
