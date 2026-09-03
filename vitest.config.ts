import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@getpaseo/plugin/server": fileURLToPath(
        new URL("./test-stubs/plugin-server.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
