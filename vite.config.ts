import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre's worker is a module: src/map/maplibre.ts has Vite build it, and MapLibre starts it
  // with `type: "module"`.
  worker: { format: "es" },
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
            {
              // MapLibre (about 1 MB) is two modules: the map, and the code it shares with its worker.
              // The map's chunk is loaded when a map is first drawn (src/map/maplibre.ts), and loads
              // this one, so neither is in the entry and neither passes the size limit above.
              // tests/maplibre-chunk.test.ts checks that the entry loads none of it.
              name: "maplibre-shared",
              test: /[\\/]node_modules[\\/]maplibre-gl[\\/]dist[\\/]maplibre-gl-shared\.mjs$/,
            },
          ],
        },
      },
    },
  },
});
