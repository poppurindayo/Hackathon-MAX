// TODO:
//   [ ] Запросы к 2GIS по рубрикам: rubric_id = rubrics[key],
//       point = `${lon},${lat}`, radius = getRadius(uid)
//   [ ] Вывод результатов списком с кнопкой «Назад» -> nav:wheretogo
//   [ ] После поиска: logSearch, фильтр по getKnownPlaceIds, recordShown
//   [ ] Кнопка «Я был здесь» -> markVisited (без неё «Посещенные места» всегда пусты)
//   [ ] Сделать правильное отображение рубрик в меню (не все)
//   [ ] Категория 'random': выбор случайного ключа из rubrics
//   [ ] Обработка ошибок 2GIS (таймаут, пустая выдача, неверный ключ)
//   [ ] Предпочтения: getTopCategories для подсказок и сортировки выдачи
//   [ ] Решить, должна ли «Очистка истории» удалять и места со статусом 'shown'
//   [ ] README: запуск, переменные .env (BOT_TOKEN, TWOGIS_KEY, DB_PATH),

import 'dotenv/config';
import { Bot, Keyboard, Context } from '@maxhub/max-bot-api';
import { Update } from '@maxhub/max-bot-api/types';
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
            // Геолокацию запрашиваем только при входе отсюда
            [Keyboard.button.callback('Куда пойти', 'nav:geo')],
            [Keyboard.button.callback('Посещенные места', 'visited_places')],
            [Keyboard.button.callback('Настройки', 'nav:settings')],
        ],
    },
    geo: {
        text: 'Чтобы подобрать места рядом, отправьте свою геолокацию',
        parent: 'main',
        rows: [
            [Keyboard.button.requestGeoLocation('Отправить геолокацию')],
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

async function editPage(page: Page, ctx: Context<Update>) {
    await ctx.answerOnCallback({
        message: { text: pages[page].text, attachments: [buildKeyboard(page)] },
    });
}

const sendPage = (page: Page, ctx: Context<Update>) =>
    ctx.reply(pages[page].text, { attachments: [buildKeyboard(page)] });

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

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data: any = await res.json();

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
}

// Очередь найденных мест на пользователя (в памяти, потеря при рестарте не страшна).
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
bot.api.setMyCommands([{
    name: 'start',
    description: 'Начать работу бота'
}]);

bot.on('bot_started', (ctx) => sendPage('main', ctx));
bot.command('start', (ctx) => sendPage('main', ctx));

// Регистрация/обновление пользователя при любом апдейте
bot.use(async (ctx, next) => {
    const user: any = ctx.user;
    if (user?.user_id !== undefined) {
        upsertUser(user.user_id, { username: user.username, firstName: user.first_name });
    }
    return next();
});

// Приветствие
const greet = async (ctx: Context<Update>) => {
    const name = (ctx.user as any)?.first_name;
    await ctx.reply(name ? `Привет, ${name}!` : 'Привет!');
    await sendPage('main', ctx);
};

bot.on('bot_started', greet);
bot.command('start', greet);

// Навигация
bot.action(/^nav:(main|wheretogo|leisure|sport|settings|geo)$/, async (ctx) => {
    await editPage(ctx.match![1] as Page, ctx);
});

// Получение геолокации
bot.on('message_created', async (ctx) => {
    const attachments: any[] = (ctx as any).message?.body?.attachments ?? [];
    const loc = attachments.find((a) => a.type === 'location');
    if (!loc) return;

    const uid = getUserId(ctx);
    if (uid === undefined) return;

    saveLocation(uid, loc.latitude, loc.longitude);
    queues.delete(uid);
    await sendPage('wheretogo', ctx);
});

// Категории: показываем по одному месту
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
        console.error('Ошибка поиска в 2GIS:', err);
        await textWithBack(ctx, 'Не удалось получить места, попробуйте позже.', 'wheretogo');
    }
});

// «Я был здесь»
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
    console.error('Не удалось запустить бота:', err);
    process.exit(1);
});
