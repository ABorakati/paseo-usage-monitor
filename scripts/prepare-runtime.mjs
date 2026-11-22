import { execSync } from "node:child_process";
import { createRequire } from "node:module";

// npm sources already have runtime dependencies. Bare Git sources carry the
// lockfile instead, so install only the locked production tree in that case.
try {
  createRequire(import.meta.url).resolve("smol-toml");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { stdio: "inherit" });
}
