import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

// The hours code reads the clock in the place's time zone, and some of it runs in the runtime's
// zone. Fix the runtime's zone, here in the main process before any worker starts, so that no
// result depends on the machine. Tests give `now` as a real instant and expect the place's clock.
process.env.TZ = "UTC";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.{ts,tsx}"],
      setupFiles: ["./tests/setup.ts"],
      // Whole-app tests draw every card and then read the whole page; on a busy machine (CI's runners,
      // or several runs at once) some take longer than the 5 s default without anything being wrong.
      // Tests wait for outcomes, not time, so a longer limit only stops a slow machine failing them.
      testTimeout: 15_000,
    },
  }),
);
