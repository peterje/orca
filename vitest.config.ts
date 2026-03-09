import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: [".orca/**", "dist/**", "node_modules/**"],
    include: ["apps/**/*.test.ts"],
  },
})
