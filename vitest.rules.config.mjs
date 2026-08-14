import { defineConfig } from 'vitest/config'

// Rules tests talk to the Firestore emulator over the network and are slow.
// Run them in a single forked process (the sandbox OOMs with the default
// worker pool while the emulator JVM is resident) and allow a generous
// per-test timeout.
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.mjs'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
})
