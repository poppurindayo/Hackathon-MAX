// TODO:
//   [ ] Предпочтения: getTopCategories для подсказок и сортировки выдачи
//   [ ] Решить, должна ли «Очистка истории» удалять и места со статусом 'shown'

import 'dotenv/config';
import { Bot, Keyboard, Context } from '@maxhub/max-bot-api';
import { Update } from '@maxhub/max-bot-api/types';
import { logger, getRequestId, getUserLogId, errorInfo, summarizeUpdate } from './logger.js';
import {
    upsertUser, saveLocation, getLocation,
    getRadius, setRadius, getVisited, clearVisited,
    logSearch, recordShown, getKnownPlaceIds, markVisitedById,
    type Location, type PlaceInput,
} from './db.js';

const TWOGIS_KEY = process.env.TWOGIS_KEY;
const TWOGIS_BASE = 'https://catalog.api.2gis.ru/3.0';

// id рубрик из API 2GIS
const rubrics = {
    // Досуг (parent_id = 2)
    cinema: '192',              // Кинотеатры
    theatre: '7332',            // Театральные, концертные мероприятия
    parks: '168',               // Парки
    attractions: '110358',      // Аттракционы
    quests: '110300',           // Квесты

    // Спорт и активный отдых (parent_id = 8)
    fitness: '268',             // Фитнес-клубы
    pools: '261',               // Бассейны
    sportSections: '51256',     // Спортивные секции
    sportSchools: '633',        // Спортивные школы
    stadiums: '634',            // Стадионы
    skateparks: '110745',       // Скейт-парки
    rollerdromes: '110335',     // Роллердромы
    iceRinks: '11974',          // Катки
};

type RubricKey = keyof typeof rubrics;
const rubricKeys = Object.keys(rubrics) as RubricKey[];
const isRubricKey = (k: string): k is RubricKey => k in rubrics;

// Подписи кнопок (ключи должны совпадать с rubrics)
const categoryLabels: Record<RubricKey, string> = {
    cinema: 'Кино',
    theatre: 'Театры и концерты',
    parks: 'Парки',
    attractions: 'Аттракционы',
    quests: 'Квесты',
    fitness: 'Фитнес-клубы',
    pools: 'Бассейны',
    sportSections: 'Спортивные секции',
    sportSchools: 'Спортивные школы',
    stadiums: 'Стадионы',
    skateparks: 'Скейт-парки',
    rollerdromes: 'Роллердромы',
    iceRinks: 'Катки',
};

// Группы для подменю
const leisureKeys: RubricKey[] = ['cinema', 'theatre', 'parks', 'attractions', 'quests'];
const sportKeys: RubricKey[] = [
    'fitness', 'pools', 'sportSections', 'sportSchools',
    'stadiums', 'skateparks', 'rollerdromes', 'iceRinks',
];

// ГЕОЛОКАЦИЯ

// Через сколько точка считается устаревшей при выборе категории
const LOCATION_TTL_MS = 30 * 60 * 1000;

function getFreshLocation(uid: number | undefined): Location | undefined {
    if (uid === undefined) return undefined;
    const loc = getLocation(uid);
    if (!loc) return undefined;
    return Date.now() - loc.ts < LOCATION_TTL_MS ? loc : undefined;
}

// Пользователи, от которых бот ждёт адрес текстом
// (запасной вариант, если кнопка геолокации не работает, (В ВЕБЕ НЕ РАБОТАЕТ как я понял) )
const awaitingAddress = new Set<number>();

// МЕНЮ
type Page = 'main' | 'wheretogo' | 'leisure' | 'sport' | 'settings' | 'geo';

type Button =
    | ReturnType<typeof Keyboard.button.callback>
    | ReturnType<typeof Keyboard.button.requestGeoLocation>;

interface PageDef {
    text: string;
    parent?: Page;
    rows: Button[][];
}

function categoryRows(keys: RubricKey[]): Button[][] {
    const buttons = keys.map((k) => Keyboard.button.callback(categoryLabels[k], `cat:${k}`));
    const rows: Button[][] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    return rows;
}

const pages: Record<Page, PageDef> = {
    main: {
        text: 'Главное меню',
        rows: [
            // Запрос геолокации
            [Keyboard.button.callback('Куда пойти', 'nav:geo')],
            [Keyboard.button.callback('Посещенные места', 'visited_places')],
            [Keyboard.button.callback('Настройки', 'nav:settings')],
        ],
    },
    geo: {
        text: 'Чтобы подобрать места рядом, отправьте свою геолокацию или введите адрес вручную',
        parent: 'main',
        rows: [
            [Keyboard.button.requestGeoLocation('Отправить геолокацию')],
            [Keyboard.button.callback('Ввести адрес вручную', 'geo:manual')],
        ],
    },
    wheretogo: {
        text: 'Пожалуйста, выберите раздел',
        parent: 'main',
        rows: [
            [Keyboard.button.callback('Досуг', 'nav:leisure')],
            [Keyboard.button.callback('Спорт и активный отдых', 'nav:sport')],
            [Keyboard.button.callback('Случайно', 'cat:random')],
        ],
    },
    leisure: {
        text: 'Досуг: выберите категорию',
        parent: 'wheretogo',
        rows: categoryRows(leisureKeys),
    },
    sport: {
        text: 'Спорт и активный отдых: выберите категорию',
        parent: 'wheretogo',
        rows: categoryRows(sportKeys),
    },
    settings: {
        text: 'Настройки',
        parent: 'main',
        rows: [
            [Keyboard.button.callback('Радиус зоны поиска', 'search_area')],
            [Keyboard.button.callback('Очистить историю посещенных мест', 'clear_visited_places')],
        ],
    },
};

function buildKeyboard(page: Page) {
    const { rows, parent } = pages[page];
    const all = parent
        ? [...rows, [Keyboard.button.callback('Назад', `nav:${parent}`)]]
        : rows;
    return Keyboard.inlineKeyboard(all);
}

// ХЕЛПЕРЫ

const getUserId = (ctx: Context<Update>): number | undefined => ctx.user?.user_id;
const getReqId = (ctx: Context<Update>): string | undefined => (ctx as any).requestId;

async function editPage(page: Page, ctx: Context<Update>) {
    await ctx.answerOnCallback({
        message: { text: pages[page].text, attachments: [buildKeyboard(page)] },
    });
}

const sendPage = (page: Page, ctx: Context<Update>) =>
    ctx.reply(pages[page].text, { attachments: [buildKeyboard(page)] });

// Главное меню новым сообщением
const sendMainMenu = (ctx: Context<Update>, greeting?: string) =>
    ctx.reply(greeting ? `${greeting}\n\n${pages.main.text}` : pages.main.text, {
        attachments: [buildKeyboard('main')],
    });

// Текст + 'Назад'
async function textWithBack(ctx: Context<Update>, text: string, backTo: Page) {
    await ctx.answerOnCallback({
        message: {
            text,
            attachments: [
                Keyboard.inlineKeyboard([
                    [Keyboard.button.callback('Назад', `nav:${backTo}`)],
                ]),
            ],
        },
    });
}

// РАДИУС ПОИСКА

const RADIUS_OPTIONS = [1000, 3000, 5000, 10000];
const formatRadius = (m: number) => `${m / 1000} км`;

async function showRadius(ctx: Context<Update>) {
    const uid = getUserId(ctx);
    const current = uid === undefined ? undefined : getRadius(uid);

    const options = RADIUS_OPTIONS.map((m) =>
        Keyboard.button.callback(
            `${m === current ? '✓ ' : ''}${formatRadius(m)}`,
            `radius:${m}`,
        ),
    );

    await ctx.answerOnCallback({
        message: {
            text: `Радиус поиска: ${current ? formatRadius(current) : '—'}\nВыберите новый:`,
            attachments: [
                Keyboard.inlineKeyboard([
                    options.slice(0, 2),
                    options.slice(2),
                    [Keyboard.button.callback('Назад', 'nav:settings')],
                ]),
            ],
        },
    });
}

// 2GIS

async function searchPlaces(key: RubricKey, loc: Location, radiusM: number): Promise<PlaceInput[]> {
    const url = new URL(`${TWOGIS_BASE}/items`);
    url.searchParams.set('key', TWOGIS_KEY ?? '');
    url.searchParams.set('rubric_id', rubrics[key]);
    url.searchParams.set('point', `${loc.lon},${loc.lat}`);
    url.searchParams.set('radius', String(radiusM));
    url.searchParams.set('sort', 'distance');
    url.searchParams.set('type', 'branch');
    url.searchParams.set('page_size', '10');
    url.searchParams.set('locale', 'ru_RU');

    // Ключ API не попадает в лог
    const logUrl = new URL(url);
    logUrl.searchParams.delete('key');
    logUrl.searchParams.delete('point')

    const startedAt = Date.now();
    logger.info('2gis.request', {
        method: 'GET',
        url: logUrl.toString(),
        category: key,
        radiusM,
    });

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const elapsedMs = Date.now() - startedAt;
        const data: any = await res.json();

        logger.info('2gis.response', {
            status: res.status,
            apiCode: data?.meta?.code,
            elapsedMs,
            category: key,
            resultCount: data?.result?.items?.length ?? 0,
        });

        if (data?.meta?.code === 404) return [];
        if (data?.meta?.code !== 200) {
            throw new Error(`2GIS: ${data?.meta?.code} ${data?.meta?.error?.message ?? ''}`);
        }

        return (data.result?.items ?? []).map((i: any) => ({
            placeId: String(i.id),
            name: i.name ?? 'Без названия',
            address: i.address_name ?? null,
            category: key,
        }));
    } catch (err) {
        logger.error('2gis.error', {
            ...errorInfo(err),
            elapsedMs: Date.now() - startedAt,
            category: key,
            radiusM,
        });
        throw err;
    }
}

// Геокодирование
interface GeocodeResult { lat: number; lon: number; name: string }

async function geocode(q: string): Promise<GeocodeResult | undefined> {
    const url = new URL(`${TWOGIS_BASE}/items/geocode`);
    url.searchParams.set('key', TWOGIS_KEY ?? '');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'items.point');
    url.searchParams.set('locale', 'ru_RU');

    const startedAt = Date.now();
    logger.info('2gis.geocode.request', { method: 'GET', queryLength: q.length });

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data: any = await res.json();

        logger.info('2gis.geocode.response', {
            status: res.status,
            apiCode: data?.meta?.code,
            elapsedMs: Date.now() - startedAt,
            resultCount: data?.result?.items?.length ?? 0,
        });

        if (data?.meta?.code === 404) return undefined;
        if (data?.meta?.code !== 200) {
            throw new Error(`2GIS geocode: ${data?.meta?.code} ${data?.meta?.error?.message ?? ''}`);
        }

        const item = data.result?.items?.[0];
        if (!item?.point) return undefined;
        return {
            lat: item.point.lat,
            lon: item.point.lon,
            name: item.full_name ?? item.address_name ?? item.name ?? q,
        };
    } catch (err) {
        logger.error('2gis.geocode.error', {
            ...errorInfo(err),
            elapsedMs: Date.now() - startedAt,
        });
        throw err;
    }
}

// Очередь найденных мест на пользователя (в памяти, потеря при рестарте не страшна)
// Кнопка «Другое» берёт следующее место из очереди без нового запроса к 2GIS.
const queues = new Map<number, { key: RubricKey; places: PlaceInput[] }>();

async function nextPlace(uid: number, key: RubricKey, loc: Location): Promise<PlaceInput | undefined> {
    let q = queues.get(uid);
    if (!q || q.key !== key || q.places.length === 0) {
        const known = getKnownPlaceIds(uid);
        const found = await searchPlaces(key, loc, getRadius(uid));
        q = { key, places: found.filter((p) => !known.has(p.placeId)) };
        queues.set(uid, q);
    }
    return q.places.shift();
}

// БОТ
const bot = new Bot(process.env.BOT_TOKEN || '');
logger.info('bot.initializing', {
    hasBotToken: Boolean(process.env.BOT_TOKEN),
    hasTwoGisKey: Boolean(TWOGIS_KEY),
});

void bot.api.setMyCommands([{
    name: 'start',
    description: 'Начать работу бота',
}]).catch((err) => logger.error('bot.commands.error', errorInfo(err)));

// Единая точка логирования и обработки ошибок для всех апдейтов.
bot.use(async (ctx, next) => {
    const requestId = getRequestId();
    const user: any = ctx.user;
    const userLogId = getUserLogId(user?.user_id);

    (ctx as any).requestId = requestId;

    logger.info('update.received', {
        requestId,
        userId: userLogId,
        ...summarizeUpdate((ctx as any).update),
        hasUser: user?.user_id !== undefined,
    });

    // Логируем исходящие ответы без тела сообщения
    const context: any = ctx;
    for (const methodName of ['reply', 'answerOnCallback']) {
        const original = context[methodName];
        if (typeof original !== 'function') continue;

        context[methodName] = async (...args: unknown[]) => {
            const startedAt = Date.now();
            try {
                const result = await original.apply(context, args);
                logger.info('bot.response', {
                    requestId,
                    userId: userLogId,
                    method: methodName,
                    elapsedMs: Date.now() - startedAt,
                    ok: true,
                });
                return result;
            } catch (err) {
                logger.error('bot.response.error', {
                    requestId,
                    userId: userLogId,
                    method: methodName,
                    elapsedMs: Date.now() - startedAt,
                    ...errorInfo(err),
                });
                throw err;
            }
        };
    }

    try {
        // Сохранение пользователя внутри общего try, если база недоступна,
        if (user?.user_id !== undefined) {
            try {
                upsertUser(user.user_id, { firstName: user.first_name });
            } catch (err) {
                logger.error('db.upsert_user.error', {
                    requestId,
                    userId: userLogId,
                    ...errorInfo(err),
                });
                throw err;
            }
        }

        await next();
        logger.info('update.completed', { requestId, userId: userLogId });
    } catch (err) {
        logger.error('update.error', {
            requestId,
            userId: userLogId,
            ...errorInfo(err),
        });

        try {
            await context.reply('Произошла внутренняя ошибка. Попробуйте ещё раз позже.');
        } catch (replyErr) {
            logger.error('error_response.failed', {
                requestId,
                userId: userLogId,
                ...errorInfo(replyErr),
            });
        }
    }
});

// Драсьте
const greet = async (ctx: Context<Update>) => {
    const uid = getUserId(ctx);
    if (uid !== undefined) awaitingAddress.delete(uid);

    logger.info('greet.sent', { requestId: getReqId(ctx), userId: getUserLogId(uid) });

    const name = (ctx.user as any)?.first_name;
    await sendMainMenu(ctx, name ? `Привет, ${name}!` : 'Привет!');
};

bot.on('bot_started', greet);
bot.command('start', greet);

// Навигация
bot.action(/^nav:(main|wheretogo|leisure|sport|settings|geo)$/, async (ctx) => {
    const uid = getUserId(ctx);
    if (uid !== undefined) awaitingAddress.delete(uid);
    await editPage(ctx.match![1] as Page, ctx);
});

// Ручной ввод адреса
bot.action('geo:manual', async (ctx) => {
    const uid = getUserId(ctx);
    if (uid === undefined) return;
    awaitingAddress.add(uid);
    await textWithBack(
        ctx,
        'Напишите адрес или город одним сообщением, например: «Москва, Тверская 1».',
        'geo',
    );
});

// Входящие сообщения. Геолокация, адрес текстом или любое другое сообщение
bot.on('message_created', async (ctx) => {
    const message = (ctx as any).message;
    const uid = getUserId(ctx);
    if (uid === undefined) return;

    // 1) Геолокация через кнопку
    const attachments: any[] = message?.body?.attachments ?? [];
    const loc = attachments.find((a) => a.type === 'location');

    if (loc) {
        awaitingAddress.delete(uid);
        saveLocation(uid, loc.latitude, loc.longitude);
        queues.delete(uid);
        logger.info('geo.received', { requestId: getReqId(ctx), userId: getUserLogId(uid), source: 'button' });
        await sendPage('wheretogo', ctx);
        return;
    }

    const text: string | undefined = message?.body?.text?.trim();

    // /start обрабатывает bot.command
    if (text && /^\/start(\s|$)/.test(text)) return;

    // 2) Адрес текстом
    if (awaitingAddress.has(uid) && text) {
        try {
            const point = await geocode(text);
            if (!point) {
                logger.info('geo.manual.not_found', { requestId: getReqId(ctx), userId: getUserLogId(uid) });
                await ctx.reply('Не нашёл такой адрес. Попробуйте уточнить, например добавьте город.');
                return;
            }

            awaitingAddress.delete(uid);
            saveLocation(uid, point.lat, point.lon);
            queues.delete(uid);
            logger.info('geo.received', { requestId: getReqId(ctx), userId: getUserLogId(uid), source: 'manual' });

            await ctx.reply(`Ищу рядом с: ${point.name}`);
            await sendPage('wheretogo', ctx);
        } catch (err) {
            logger.error('geo.manual.error', {
                requestId: getReqId(ctx),
                userId: getUserLogId(uid),
                ...errorInfo(err),
            });
            await ctx.reply('Не удалось определить адрес, попробуйте позже.');
        }
        return;
    }

    // 3) Любое другое текстовое сообщение
    logger.info('message.unrecognized', {
        requestId: getReqId(ctx),
        userId: getUserLogId(uid)
    });
    await ctx.reply('Введите корректную команду');
});

// Категории
bot.action(/^cat:(\w+)$/, async (ctx) => {
    const uid = getUserId(ctx);
    const location = getFreshLocation(uid);
    if (uid === undefined || !location) return editPage('geo', ctx);

    const raw = ctx.match![1];
    const key = raw === 'random'
        ? rubricKeys[Math.floor(Math.random() * rubricKeys.length)]
        : isRubricKey(raw) ? raw : undefined;

    if (!key) return textWithBack(ctx, 'Неизвестная категория.', 'wheretogo');

    try {
        const place = await nextPlace(uid, key, location);

        if (!place) {
            return textWithBack(
                ctx,
                'Больше новых мест не нашлось. Попробуйте другую категорию или увеличьте радиус в настройках.',
                'wheretogo',
            );
        }

        recordShown(uid, [place]);
        logSearch(uid, raw, location.lat, location.lon, getRadius(uid));

        await ctx.answerOnCallback({
            message: {
                text: `${place.name}\n${place.address ?? 'Адрес не указан'}`,
                attachments: [
                    Keyboard.inlineKeyboard([
                        [Keyboard.button.link('Открыть в 2GIS', `https://2gis.ru/firm/${place.placeId}`)],
                        [Keyboard.button.callback('Я был здесь', `visit:${place.placeId}`)],
                        [Keyboard.button.callback('Другое', `cat:${raw}`)],
                        [Keyboard.button.callback('Назад', 'nav:wheretogo')],
                    ]),
                ],
            },
        });
    } catch (err) {
        logger.error('search.error', {
            requestId: getReqId(ctx),
            userId: getUserLogId(uid),
            ...errorInfo(err),
        });
        await textWithBack(ctx, 'Не удалось получить места, попробуйте позже.', 'wheretogo');
    }
});

// «Kilroy was here» button
bot.action(/^visit:([\w-]+)$/, async (ctx) => {
    const uid = getUserId(ctx);
    const ok = uid !== undefined && markVisitedById(uid, ctx.match![1]);
    await textWithBack(
        ctx,
        ok ? 'Отмечено! Место появится в «Посещенных местах».' : 'Не удалось найти это место.',
        'wheretogo',
    );
});

// Посещённые места
bot.action('visited_places', async (ctx) => {
    const uid = getUserId(ctx);
    const visited = uid === undefined ? [] : getVisited(uid, 10);

    const text = visited.length === 0
        ? 'Вы пока нигде не отметились'
        : 'Посещённые места:\n\n' + visited
            .map((p, i) => `${i + 1}. ${p.name}${p.address ? ` — ${p.address}` : ''}`)
            .join('\n');

    await textWithBack(ctx, text, 'main');
});

// Очистка истории посещённых мест
bot.action('clear_visited_places', async (ctx) => {
    const uid = getUserId(ctx);
    const n = uid === undefined ? 0 : clearVisited(uid);
    await textWithBack(ctx, n > 0 ? `История очищена (удалено мест: ${n})` : 'История уже пуста', 'settings');
});

// Радиус поиска
bot.action('search_area', showRadius);

bot.action(/^radius:(\d+)$/, async (ctx) => {
    const uid = getUserId(ctx);
    const value = Number(ctx.match![1]);
    if (uid !== undefined && RADIUS_OPTIONS.includes(value)) {
        setRadius(uid, value);
        queues.delete(uid);
    }
    await showRadius(ctx);
});

bot.start().catch((err) => {
    logger.error('bot.start.error', errorInfo(err));
    process.exit(1);
});