/**
 * The pictures that would not load this session, by address. Each is asked for once: after that the
 * initial stands in its place, wherever the account button is drawn again (a phone draws it on
 * Explore only). Kept apart from the button so that tests can forget it between one test and the
 * next without loading the shell (tests/setup.ts).
 */
const unloadable = new Set<string>();

/** Whether the picture at `address` has failed to load this session. */
export function isUnloadablePicture(address: string): boolean {
  return unloadable.has(address);
}

/** Notes that the picture at `address` would not load. */
export function noteUnloadablePicture(address: string): void {
  unloadable.add(address);
}

/** Forgets every picture that would not load. A reload does the same; tests call it between one test and the next. */
export function forgetUnloadablePictures(): void {
  unloadable.clear();
}
