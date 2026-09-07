import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@getpaseo/plugin/server": fileURLToPath(
        new URL("./test-stubs/plugin-server.ts", import.meta.url),
      ),
      "@getpaseo/plugin": fileURLToPath(new URL("./test-stubs/plugin-client.ts", import.meta.url)),
      "react-native": fileURLToPath(new URL("./test-stubs/react-native.ts", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
