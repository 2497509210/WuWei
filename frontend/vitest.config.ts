import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      react: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      "react-dom": fileURLToPath(new URL("./node_modules/react-dom", import.meta.url)),
      "@testing-library/react": fileURLToPath(new URL("./node_modules/@testing-library/react/dist/index.js", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    include: ["../tests/frontend/**/*.test.ts"],
    environment: "node",
  },
  server: {
    fs: {
      allow: ["../.."],
    },
  },
});
