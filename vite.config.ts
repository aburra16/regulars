import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // opening_hours is LGPL-3.0 (docs/decisions.md #13). It ships unmodified, in a file of
              // its own, with the two packages it depends on. tests/opening-hours-chunk.test.ts
              // checks that the build does this.
              name: "opening-hours",
              test: /[\\/]node_modules[\\/](?:opening_hours|suncalc|i18next)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
