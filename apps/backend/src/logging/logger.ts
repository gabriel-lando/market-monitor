import pino from 'pino';

import type { LogLevel, RuntimeMode } from '@market-monitor/shared';

export function createLogger(level: LogLevel, deploymentMode: string, appEnv: RuntimeMode) {
  return pino({
    level,
    base: {
      service: 'market-monitor-backend',
      deployment_mode: deploymentMode,
      app_env: appEnv,
    },
  });
}
