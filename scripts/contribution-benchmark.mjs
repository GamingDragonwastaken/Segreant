import { runContributionBenchmark } from '../test/support/contribution-benchmark.ts';

const report = runContributionBenchmark();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed === 0 ? 0 : 1;
