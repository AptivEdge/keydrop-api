import * as winston from 'winston';
import WinstonCloudWatch from 'winston-cloudwatch';

// Helper function to strip ANSI color codes
const stripAnsi = (str: string | any): string | any => {
  if (typeof str !== 'string') return str;
  return str.replace(/\u001b\[\d+m/g, '');
};

export function createCloudWatchTransport(options: {
  logGroupName: string;
  logStreamName: string;
  awsRegion: string;
  level?: string;
}): winston.transport {
  return new WinstonCloudWatch({
    logGroupName: options.logGroupName,
    logStreamName: options.logStreamName,
    awsRegion: options.awsRegion,
    messageFormatter: (item) => {
      // Strip any ANSI colors that might have made it this far
      const cleanMessage = stripAnsi(item.message);
      const cleanLevel = stripAnsi(item.level);

      // Process meta data recursively to strip colors in nested properties
      const cleanMeta = { ...item.meta };
      Object.keys(cleanMeta).forEach((key) => {
        if (typeof cleanMeta[key] === 'string') {
          cleanMeta[key] = stripAnsi(cleanMeta[key]);
        }
      });

      return JSON.stringify({
        timestamp: new Date().toISOString(),
        level: cleanLevel,
        message: cleanMessage,
        ...cleanMeta,
      });
    },
    level: options.level || 'info',
  });
}
