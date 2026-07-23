import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  resolve: {
    alias: {
      vue: "vue/dist/vue.esm-bundler.js"
    }
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true
  },
  server: {
    port: 3004,
    proxy: {
      "/api": "http://localhost:3003"
    }
  }
});
