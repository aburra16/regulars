import { describe, expect, it } from "vitest";

import { assertLocal } from "./proof/local";

// The proof publishes test events. This guard is what keeps them off every relay but one on this machine.
describe("assertLocal", () => {
  it.each([
    "wss://dcosl.brainstorm.world",
    "wss://scores.brainstorm.world",
    "ws://10.0.0.1:7777",
    // Names that start or end like a local host, and a user part that looks like one.
    "ws://localhost.example.com:10547",
    "ws://127.0.0.1.nip.io:10547",
    "ws://localhost@example.com:10547",
    // Not a relay URL at all.
    "http://localhost:10547",
    "localhost:10547",
    "",
  ])("refuses %j", (url) => {
    expect(() => assertLocal(url)).toThrow(/only on this machine/);
  });

  it.each(["ws://localhost:10547", "ws://127.0.0.1:10547", "ws://[::1]:10547"])("allows %s", (url) => {
    expect(() => assertLocal(url)).not.toThrow();
  });
});
