/**
 * Production logging for the desktop agent.
 *
 * Writes structured JSON logs to logs/agent-YYYY-MM-DD.log (one file per UTC day) and mirrors a
 * pretty line to the console. Log level is controlled by config.logLevel (default 'info'). The
 * GET /logs local endpoint tails the current day's file.
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';
export function createLogger(baseDir, level = 'info') {
    const logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const currentLogFile = () => path.join(logDir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
    // Two sinks: a JSON file (durable, machine-readable) + pretty stdout for the console window.
    const streams = [
        { level: level, stream: pino.destination({ dest: currentLogFile(), append: true, sync: false }) },
        { level: level, stream: process.stdout },
    ];
    const log = pino({ level, base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.isoTime }, pino.multistream(streams));
    return { log, currentLogFile, logDir };
}
//# sourceMappingURL=logger.js.map