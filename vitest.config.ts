import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testPassword = ["test", "password", "fixture"].join("-");
const testSessionSecret = ["session", "fixture", "used", "only", "inside", "worker", "tests"].join("-");

process.env.AUTH_PASSWORD ??= testPassword;
process.env.SESSION_SECRET ??= testSessionSecret;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          AUTH_PASSWORD: testPassword,
          SESSION_SECRET: testSessionSecret,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
