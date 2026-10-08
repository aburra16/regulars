import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The opening_hours chunk below is 714 kB (116 kB gzip), most of it the library's own tables, and
    // it has to stay one file of its own. The warning's default of 500 kB would fire on every build.
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // opening_hours is LGPL-3.0 (docs/decisions.md #13). It ships unmodified, in a file of
              // its own, with suncalc, the one package it imports. tests/opening-hours-chunk.test.ts
              // checks that the build does this.
              name: "opening-hours",
              test: /[\\/]node_modules[\\/](?:opening_hours|suncalc)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
