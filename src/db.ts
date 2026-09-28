import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/bot.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ───────────────────────── Миграции ─────────────────────────
// Новые изменения схемы = новый элемент в конец массива.
// Уже применённые миграции повторно не запускаются (PRAGMA user_version).
const MIGRATIONS: string[] = [
    `
    CREATE TABLE users (
        user_id      INTEGER PRIMARY KEY,
        username     TEXT,
        first_name   TEXT,
        radius_m     INTEGER NOT NULL DEFAULT 3000,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
    );

    -- Последняя известная геолокация (одна строка на пользователя)
    CREATE TABLE locations (
        user_id    INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        lat        REAL NOT NULL,
        lon        REAL NOT NULL,
        updated_at INTEGER NOT NULL
    );

    -- История поисков: что и где искал пользователь
    CREATE TABLE searches (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        category   TEXT NOT NULL,
        lat        REAL NOT NULL,
        lon        REAL NOT NULL,
        radius_m   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_searches_user ON searches(user_id, created_at DESC);

    -- Места, которые бот показывал ('shown') или где пользователь побывал ('visited')
    CREATE TABLE user_places (
        user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        place_id   TEXT NOT NULL,           -- id объекта в 2GIS
        name       TEXT NOT NULL,
        address    TEXT,
        category   TEXT,
        status     TEXT NOT NULL CHECK (status IN ('shown', 'visited')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, place_id)
    );
    CREATE INDEX idx_user_places_status ON user_places(user_id, status, updated_at DESC);
    `,
];

function migrate() {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
        db.transaction(() => {
            db.exec(MIGRATIONS[v]);
            db.pragma(`user_version = ${v + 1}`);
        })();
    }
}
migrate();

// ───────────────────────── Типы ─────────────────────────
export type Location = { lat: number; lon: number; ts: number };

export interface PlaceInput {
    placeId: string;
    name: string;
    address?: string | null;
    category?: string | null;
}

export interface VisitedPlace {
    place_id: string;
    name: string;
    address: string | null;
    category: string | null;
    updated_at: number;
}

export const DEFAULT_RADIUS_M = 3000;

// ───────────────────────── Пользователи ─────────────────────────
const stmtUpsertUser = db.prepare(`
    INSERT INTO users (user_id, username, first_name, created_at, last_seen_at)
    VALUES (@userId, @username, @firstName, @now, @now)
    ON CONFLICT(user_id) DO UPDATE SET
        username     = COALESCE(excluded.username, users.username),
        first_name   = COALESCE(excluded.first_name, users.first_name),
        last_seen_at = excluded.last_seen_at
`);

export function upsertUser(userId: number, info: { username?: string; firstName?: string } = {}) {
    stmtUpsertUser.run({
        userId,
        username: info.username ?? null,
        firstName: info.firstName ?? null,
        now: Date.now(),
    });
}

// ───────────────────────── Настройки ─────────────────────────
const stmtGetRadius = db.prepare(`SELECT radius_m FROM users WHERE user_id = ?`);
const stmtSetRadius = db.prepare(`UPDATE users SET radius_m = ? WHERE user_id = ?`);

export function getRadius(userId: number): number {
    const row = stmtGetRadius.get(userId) as { radius_m: number } | undefined;
    return row?.radius_m ?? DEFAULT_RADIUS_M;
}

export function setRadius(userId: number, radiusM: number) {
    stmtSetRadius.run(radiusM, userId);
}

// ───────────────────────── Геолокация ─────────────────────────
const stmtSaveLocation = db.prepare(`
    INSERT INTO locations (user_id, lat, lon, updated_at)
    VALUES (@userId, @lat, @lon, @now)
    ON CONFLICT(user_id) DO UPDATE SET
        lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at
`);
const stmtGetLocation = db.prepare(`
    SELECT lat, lon, updated_at AS ts FROM locations WHERE user_id = ?
`);

export function saveLocation(userId: number, lat: number, lon: number) {
    stmtSaveLocation.run({ userId, lat, lon, now: Date.now() });
}

export function getLocation(userId: number): Location | undefined {
    return stmtGetLocation.get(userId) as Location | undefined;
}

// ───────────────────────── История поиска и предпочтения ─────────────────────────
const stmtLogSearch = db.prepare(`
    INSERT INTO searches (user_id, category, lat, lon, radius_m, created_at)
    VALUES (@userId, @category, @lat, @lon, @radiusM, @now)
`);
const stmtTopCategories = db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM searches
    WHERE user_id = ? AND category != 'random'
    GROUP BY category
    ORDER BY count DESC, MAX(created_at) DESC
    LIMIT ?
`);
const stmtRecentSearches = db.prepare(`
    SELECT category, lat, lon, created_at FROM searches
    WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
`);

export function logSearch(userId: number, category: string, lat: number, lon: number, radiusM: number) {
    stmtLogSearch.run({ userId, category, lat, lon, radiusM, now: Date.now() });
}

/** Любимые категории пользователя (по числу поисков) — основа «предпочтений». */
export function getTopCategories(userId: number, limit = 3) {
    return stmtTopCategories.all(userId, limit) as { category: string; count: number }[];
}

export function getRecentSearches(userId: number, limit = 10) {
    return stmtRecentSearches.all(userId, limit) as {
        category: string; lat: number; lon: number; created_at: number;
    }[];
}

// ───────────────────────── Места: показанные и посещённые ─────────────────────────
const stmtRecordShown = db.prepare(`
    INSERT INTO user_places (user_id, place_id, name, address, category, status, updated_at)
    VALUES (@userId, @placeId, @name, @address, @category, 'shown', @now)
    ON CONFLICT(user_id, place_id) DO UPDATE SET updated_at = excluded.updated_at
`); // статус 'visited' не затираем

const stmtMarkVisited = db.prepare(`
    INSERT INTO user_places (user_id, place_id, name, address, category, status, updated_at)
    VALUES (@userId, @placeId, @name, @address, @category, 'visited', @now)
    ON CONFLICT(user_id, place_id) DO UPDATE SET status = 'visited', updated_at = excluded.updated_at
`);

const stmtGetVisited = db.prepare(`
    SELECT place_id, name, address, category, updated_at FROM user_places
    WHERE user_id = ? AND status = 'visited'
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
`);
const stmtShownIds = db.prepare(`SELECT place_id FROM user_places WHERE user_id = ?`);
const stmtClearVisited = db.prepare(`DELETE FROM user_places WHERE user_id = ? AND status = 'visited'`);

export const recordShown = db.transaction((userId: number, places: PlaceInput[]) => {
    const now = Date.now();
    for (const p of places) {
        stmtRecordShown.run({
            userId, placeId: p.placeId, name: p.name,
            address: p.address ?? null, category: p.category ?? null, now,
        });
    }
});

export function markVisited(userId: number, p: PlaceInput) {
    stmtMarkVisited.run({
        userId, placeId: p.placeId, name: p.name,
        address: p.address ?? null, category: p.category ?? null, now: Date.now(),
    });
}

export function getVisited(userId: number, limit = 10, offset = 0) {
    return stmtGetVisited.all(userId, limit, offset) as VisitedPlace[];
}

/** id всех мест, которые уже показывались/посещались — чтобы не предлагать повторно. */
export function getKnownPlaceIds(userId: number): Set<string> {
    const rows = stmtShownIds.all(userId) as { place_id: string }[];
    return new Set(rows.map((r) => r.place_id));
}

export function clearVisited(userId: number): number {
    return stmtClearVisited.run(userId).changes;
}

export default db;
