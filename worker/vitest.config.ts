import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep vitest isolated from the parent Next.js project's PostCSS / CSS
  // pipeline — we only test plain TypeScript here.
  root: '/home/z/my-project/download/micky-assistant/worker',
  css: { postcss: { plugins: [] } },
  test: {
    // Adapters live under src/ (Mistral/Gemini/Groq/OpenRouter/WorkersAI);
    // some sibling agents also use a top-level tests/ dir. Cover both so a
    // test file is found regardless of where the author placed it.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
