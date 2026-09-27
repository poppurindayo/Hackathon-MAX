import 'dotenv/config';
import { Bot, Keyboard, Context } from '@maxhub/max-bot-api';
import { Update } from '@maxhub/max-bot-api/types';

// 1. Клавиатуры
const mainmenu_keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Куда пойти', 'nav:wheretogo')],

    [Keyboard.button.callback('Посещенные места', 'visited_places')],
]);

const wheretogo_keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Выставки, кино, театр', 'culture'),
     Keyboard.button.callback('Концерты', 'concerts')],

    [Keyboard.button.callback('Развлечения и сходки', 'entertainment'),
     Keyboard.button.callback('Интересные места', 'interesting_places')],

    [Keyboard.button.callback('Активный отдых', 'active_leisure'),
     Keyboard.button.callback('Случайно', 'random')],

    [Keyboard.button.callback('Назад', 'nav:main')],
]);

// 2. Типы и карта меню
type MenuPage = 'main' | 'wheretogo';

const menus: Record<MenuPage, { text: string; keyboard: any }> = {
    main: {
        text: 'Чем бы вы хотели заняться',
        keyboard: mainmenu_keyboard },
    wheretogo: {
        text: 'Пожалуйста, выберите категорию',
        keyboard: wheretogo_keyboard },
};

// 3. Функции
async function menuNav(page: MenuPage, ctx: Context<Update>) {
    const menu = menus[page];
    await ctx.answerOnCallback({
        message: {
            text: menu.text,
            attachments: [menu.keyboard] },
    });
}

const showMenu = (ctx: Context<Update>) =>
    ctx.reply(menus.main.text, { attachments: [mainmenu_keyboard] });

// 4. Бот и команды
const bot = new Bot(process.env.BOT_TOKEN || '');
bot.api.setMyCommands([{ name: 'start', description: 'Начать работу бота' }]);

// 5. Обработчики
bot.on('bot_started', showMenu);
bot.command('start', showMenu);

bot.action(/^nav:(main|wheretogo)$/, async (ctx) => {
    const page = ctx.match![1] as MenuPage;
    await menuNav(page, ctx);
});

bot.action('culture', async (ctx) => {
    await ctx.answerOnCallback({ message: { text: 'Пожалуйста, выберите время и укажите регион' } });
});

bot.action(/^(concerts|entertainment|active_leisure|interesting_places|random)$/, async (ctx) => {
    await ctx.answerOnCallback({ message: { text: 'В разработке' } });
});

// 6. Запуск
bot.start().catch((err) => {
    console.error('Не удалось запустить бота:', err);
    process.exit(1);
});