// TODO:
//   [ ] Запросы к 2GIS по рубрикам: rubric_id = rubrics[key],
//       point = `${lon},${lat}`, radius = getRadius(uid)
//   [ ] Вывод результатов списком с кнопкой «Назад» -> nav:wheretogo
//   [ ] После поиска: logSearch, фильтр по getKnownPlaceIds, recordShown
//   [ ] Кнопка «Я был здесь» -> markVisited (без неё «Посещенные места» всегда пусты)
//   [ ] Категория 'museums': найти rubric_id и добавить в rubrics
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
    getRadius, setRadius, getVisited, clearVisited, type Location,
} from './db.js';

const TWOGIS_KEY = process.env.TWOGIS_KEY;
const TWOGIS_BASE = 'https://catalog.api.2gis.ru/3.0';

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
type Page = 'main' | 'wheretogo' | 'settings' | 'geo';

type Button =
    | ReturnType<typeof Keyboard.button.callback>
    | ReturnType<typeof Keyboard.button.requestGeoLocation>;

interface PageDef {
    text: string;
    parent?: Page;
    rows: Button[][];
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
        text: 'Пожалуйста, выберите категорию',
        parent: 'main',
        rows: [
            [Keyboard.button.callback('Кино', 'cat:cinema'),
             Keyboard.button.callback('Театр', 'cat:theatre')],

            [Keyboard.button.callback('Музеи', 'cat:museums'),
             Keyboard.button.callback('Парки', 'cat:parks')],

            [Keyboard.button.callback('Спортивные секции', 'cat:sportSections'),
             Keyboard.button.callback('Спортивные площадки', 'cat:stadiums')],

            [Keyboard.button.callback('Случайно', 'cat:random')],
        ],
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

const wip = (ctx: Context<Update>, backTo: Page) => textWithBack(ctx, 'В разработке', backTo);

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
bot.action(/^nav:(main|wheretogo|settings|geo)$/, async (ctx) => {
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
    await sendPage('wheretogo', ctx);
});

// Категории
bot.action(/^cat:(\w+)$/, async (ctx) => {
    const location = getFreshLocation(getUserId(ctx));
    if (!location) return editPage('geo', ctx);

    // TODO: Запрос к 2GIS: rubric_id = rubrics[key], point = `${location.lon},${location.lat}`,
    // radius = getRadius(uid); затем logSearch, фильтр по getKnownPlaceIds, recordShown
    await wip(ctx, 'wheretogo');
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
    }
    await showRadius(ctx);
});

bot.start().catch((err) => {
    console.error('Не удалось запустить бота:', err);
    process.exit(1);
});
