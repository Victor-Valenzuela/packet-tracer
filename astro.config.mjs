// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // GitHub Pages: https://victorBBQ.github.io/packet-tracer/
  site: "https://victorBBQ.github.io",
  base: "/packet-tracer",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
