// TODO:    2GIS запросы по рубрикам
//          БД, чтобы сохранялась геолокация и userID, а не сбрасывалась постоянно
//          Раздел 'Посещенные места'
//          Настройка радиуса зоны поиска
//          Очистка посещенных мест
//          


import 'dotenv/config';
import { Bot, Keyboard, Context } from '@maxhub/max-bot-api';
import { Update } from '@maxhub/max-bot-api/types';
import {
    upsertUser, saveLocation, getLocation, logSearch,
    getRadius, getVisited, clearVisited, type Location,
} from './db';

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

// Геолокация с временем сохранения
type Location = { lat: number; lon: number; ts: number };
const userLocations = new Map<number, Location>();

// Через сколько точка считается устаревшей при выборе категории
const LOCATION_TTL_MS = 30 * 60 * 1000;

function getFreshLocation(uid: number | undefined): Location | undefined {
    if (uid === undefined) return undefined;
    const loc = userLocations.get(uid);
    if (!loc) return undefined;
    return Date.now() - loc.ts < LOCATION_TTL_MS ? loc : undefined;
}

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
        text: 'Title Text',
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

// Заглушка «В разработке» с кнопкой «Назад» на нужную страницу
async function wip(ctx: Context<Update>, backTo: Page) {
    await ctx.answerOnCallback({
        message: {
            text: 'В разработке',
            attachments: [
                Keyboard.inlineKeyboard([
                    [Keyboard.button.callback('Назад', `nav:${backTo}`)],
                ]),
            ],
        },
    });
}

// Бот
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
 
bot.on('bot_started', (ctx) => sendPage('main', ctx));
bot.command('start', (ctx) => sendPage('main', ctx));

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

    userLocations.set(uid, { lat: loc.latitude, lon: loc.longitude, ts: Date.now() });
    await sendPage('wheretogo', ctx);
});

// Категории
bot.action(/^cat:(\w+)$/, async (ctx) => {
    const location = getFreshLocation(getUserId(ctx));
    if (!location) return editPage('geo', ctx);

    // TODO: Запрос к 2GIS: rubric_id = rubrics[key], point = `${location.lon},${location.lat}`
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

// Остальные разделы в разработке
bot.action('visited_places', (ctx) => wip(ctx, 'main'));
bot.action(/^(search_area|clear_visited_places)$/, (ctx) => wip(ctx, 'settings'));

bot.start().catch((err) => {
    console.error('Не удалось запустить бота:', err);
    process.exit(1);
});
