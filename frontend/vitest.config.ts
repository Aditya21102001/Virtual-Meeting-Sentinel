import { defineConfig } from 'vitest/config';

/**
 * Vitest is run through Angular's unit-test builder, which reads this for pool settings.
 *
 * Everything here exists for one reason: this machine runs the suite with roughly 2 GB free, and
 * Vitest's default is a pool of forked workers sized to the CPU count. Each fork loads its own copy
 * of the compiled application, so the default fanned out into several hundred megabytes apiece and
 * the workers timed out before they could report — which surfaces as "Failed to start forks worker",
 * not as an out-of-memory error, and reads like a broken runner rather than a starved one.
 */
export default defineConfig({
  test: {
    // Threads share one process image; forks do not. On a memory-tight host that difference is the
    // whole budget.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true, maxThreads: 1, minThreads: 1 },
    },
    // One file at a time, for the same reason.
    fileParallelism: false,
    // The default 5s is measured from a warm runner. The first file here pays for compiling the
    // application, and timing out mid-compile looks like a failing test rather than a slow start.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
