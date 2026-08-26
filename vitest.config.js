const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
