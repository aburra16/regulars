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
    },
  }),
);
