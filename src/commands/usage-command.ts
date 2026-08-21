import { UsageLog } from '../usage/usage-log.js';
import { buildUsageReport } from '../usage/usage-report.js';
import { renderLocalUsageReport } from '../usage/render-usage.js';

export async function runUsage(log: UsageLog = new UsageLog()): Promise<void> {
  const entries = await log.readAll();
  console.log(renderLocalUsageReport(buildUsageReport(entries)));
}
