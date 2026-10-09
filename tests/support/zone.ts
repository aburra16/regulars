import { vi } from "vitest";

/**
 * The real `resolvedOptions`, taken once, before any test stands in for it: a test that sets the zone
 * twice wraps this, not its own stand-in, which would call itself until the stack ran out.
 */
export const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

/**
 * The device's time zone, as `Intl` says it; everything else `Intl` says is as it is. Undefined: a
 * browser that names none. `vi.restoreAllMocks` puts the real one back.
 */
export function zoneIs(zone: string | undefined): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolvedOptions.call(this), timeZone: zone as string };
  });
}
