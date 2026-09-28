import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const LOG_PATH = process.env.LOG_PATH || './logs/bot.log';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(level: Level): boolean {
    return LEVELS[level] >= (LEVELS[LOG_LEVEL as Level] ?? LEVELS.info);
}

function sanitize(value: unknown): unknown {
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            const isSecretKey = /token|secret|password|authorization|api.?key/i.test(key);
            if (isSecretKey && typeof val !== 'boolean') {
                out[key] = '[REDACTED]';
            } else {
                out[key] = sanitize(val);
            }
        }
        return out;
    }
    return value;
}

let writeQueue: Promise<void> = Promise.resolve();
let dirReady = false;

function write(level: Level, event: string, meta: Meta = {}): void {
    if (!shouldLog(level)) return;

    const record = {
        ts: new Date().toISOString(),
        level,
        event,
        ...(sanitize(meta) as Meta),
    };
    const line = JSON.stringify(record) + '\n';

    // Очередь логов
    writeQueue = writeQueue
        .then(async () => {
            if (!dirReady) {
                await mkdir(dirname(LOG_PATH), { recursive: true });
                dirReady = true;
            }
            await appendFile(LOG_PATH, line, 'utf8');
        })
        .catch((err) => console.error('Logger write failed:', err));
}

export const logger = {
    debug: (event: string, meta?: Meta) => write('debug', event, meta),
    info: (event: string, meta?: Meta) => write('info', event, meta),
    warn: (event: string, meta?: Meta) => write('warn', event, meta),
    error: (event: string, meta?: Meta) => write('error', event, meta),
};

export function getRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Стабильный псевдоним пользователя для логов вместо реального MAX user_id. */
export function getUserLogId(userId: number | undefined): string | undefined {
    if (userId === undefined) return undefined;
    return createHash('sha256')
        .update(`${process.env.LOG_SALT || 'hackathon-max'}:${userId}`)
        .digest('hex')
        .slice(0, 12);
}

export function errorInfo(err: unknown): Meta {
    if (err instanceof Error) {
        return { name: err.name, message: err.message, stack: err.stack };
    }
    return { message: String(err) };
}


// Сводка апдейта MAX для логов.
export function summarizeUpdate(update: any): Meta {
    if (!update || typeof update !== 'object') {
        return { updateType: typeof update };
    }

    const body = update.message?.body;
    const rawText: unknown = body?.text;
    const text = typeof rawText === 'string' ? rawText.trim() : undefined;
    const attachments: any[] = Array.isArray(body?.attachments) ? body.attachments : [];

    return {
        updateType: update.update_type,
        updateTs: update.timestamp,
        mid: body?.mid,
        hasText: Boolean(text),
        textLength: text?.length,
        // Только имя команды (первое слово), без аргументов.
        command: text?.startsWith('/') ? text.split(/\s+/)[0].slice(0, 32) : undefined,
        attachmentTypes: attachments.length ? attachments.map((a) => a?.type) : undefined,
        // Собственные значения кнопок
        callbackPayload: update.callback?.payload,
        // Ключи апдейта
        keys: LOG_LEVEL === 'debug' ? Object.keys(update) : undefined,
    };
}