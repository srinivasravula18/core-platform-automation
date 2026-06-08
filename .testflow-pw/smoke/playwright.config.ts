import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 60000,
  reporter: [['json', { outputFile: 'results.json' }]],
  outputDir: './artifacts',
  use: {
    
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
