// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // GitHub Pages: https://victor-valenzuela.github.io/packet-tracer/
  site: "https://victor-valenzuela.github.io",
  base: "/packet-tracer",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
