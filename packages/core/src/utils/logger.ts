/**
 * Structured Logger Implementation
 * 
 * Centralized logging with configurable levels and contexts.
 */

import { LOG_LEVELS, type Logger, type LogLevel } from '../ports';

// Declare process for TypeScript when not in Node context
declare const process: { env?: Record<string, string | undefined> } | undefined;

export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: Date;
    context?: Record<string, unknown> | undefined;
}

export type LogOutput = (entry: LogEntry) => void;

class LoggerImpl implements Logger {
    private level: LogLevel;
    private outputs: LogOutput[];

    constructor(level: LogLevel = LOG_LEVELS.INFO, outputs: LogOutput[] = []) {
        this.level = level;
        this.outputs = outputs.length > 0 ? outputs : [this.consoleOutput];
    }

    private consoleOutput: LogOutput = (entry) => {
        const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
        const prefix = `[${entry.timestamp.toISOString()}] [${levelNames[entry.level]}]`;
        const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : '';

        switch (entry.level) {
            case LOG_LEVELS.ERROR:
                console.error(`${prefix} ${entry.message}${contextStr}`);
                break;
            case LOG_LEVELS.WARN:
                console.warn(`${prefix} ${entry.message}${contextStr}`);
                break;
            default:
                console.log(`${prefix} ${entry.message}${contextStr}`);
        }
    };

    private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
        if (level > this.level) return;

        const entry: LogEntry = {
            level,
            message,
            timestamp: new Date(),
            context,
        };

        for (const output of this.outputs) {
            output(entry);
        }
    }

    error(message: string, context?: Record<string, unknown>): void {
        this.log(LOG_LEVELS.ERROR, message, context);
    }

    warn(message: string, context?: Record<string, unknown>): void {
        this.log(LOG_LEVELS.WARN, message, context);
    }

    info(message: string, context?: Record<string, unknown>): void {
        this.log(LOG_LEVELS.INFO, message, context);
    }

    debug(message: string, context?: Record<string, unknown>): void {
        this.log(LOG_LEVELS.DEBUG, message, context);
    }

    verbose(message: string, context?: Record<string, unknown>): void {
        this.log(LOG_LEVELS.VERBOSE, message, context);
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    addOutput(output: LogOutput): void {
        this.outputs.push(output);
    }
}

// Singleton instance
let loggerInstance: LoggerImpl | null = null;

/**
 * Get the logger instance
 */
export function getLogger(): Logger {
    if (!loggerInstance) {
        const debug = typeof process !== 'undefined' && process?.env?.BACKBRAIN_DEBUG === 'true';
        const verbose = typeof process !== 'undefined' && process?.env?.BACKBRAIN_VERBOSE === 'true';

        const level = verbose ? LOG_LEVELS.VERBOSE : debug ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;
        loggerInstance = new LoggerImpl(level);
    }
    return loggerInstance;
}

/**
 * Configure the logger
 */
export function configureLogger(level: LogLevel, outputs?: LogOutput[]): void {
    const debug = typeof process !== 'undefined' && process?.env?.BACKBRAIN_DEBUG === 'true';
    const effectiveLevel = debug ? Math.max(level, LOG_LEVELS.DEBUG) as LogLevel : level;

    loggerInstance = new LoggerImpl(effectiveLevel, outputs);
}

/**
 * Add a log output to the global logger instance.
 * Safe to call even before the logger is initialized.
 */
export function addLoggerOutput(output: LogOutput): void {
    if (loggerInstance) {
        loggerInstance.addOutput(output);
    }
}

/**
 * Create a logger with a namespace prefix
 */
export function createLogger(namespace: string): Logger {
    const baseLogger = getLogger();
    return {
        error: (msg, ctx) => baseLogger.error(`[${namespace}] ${msg}`, ctx),
        warn: (msg, ctx) => baseLogger.warn(`[${namespace}] ${msg}`, ctx),
        info: (msg, ctx) => baseLogger.info(`[${namespace}] ${msg}`, ctx),
        debug: (msg, ctx) => baseLogger.debug(`[${namespace}] ${msg}`, ctx),
        verbose: (msg, ctx) => baseLogger.verbose(`[${namespace}] ${msg}`, ctx),
    };
}
