import { defineConfig } from "vitest/config";

// The local-relay proofs (`npm run proof:house-scores`), apart from `npm test`: they need a relay
// running on this machine (README, "House scores, locally"). They run in Node with its own
// WebSocket, so none of tests/setup.ts applies: no socket stub, no jsdom, no IndexedDB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/proof/*.proof.ts"],
    // A proof prints what it found. Some reporters keep a passing test's output back.
    reporters: ["default"],
    // Long enough for the relay reader's own limits (20 s to answer) to fail a step first, with
    // their message, rather than Vitest's timeout with none.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
