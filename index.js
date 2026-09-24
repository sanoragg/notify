require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'schedule.json');

// Загрузка и сохранение данных
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {};
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUserData(chatId) {
  const data = loadData();
  if (!data[chatId]) {
    data[chatId] = {
      subscribed: true,
      schedule: {
        even: { 1: { pairs: [], work: null }, 2: { pairs: [], work: null }, 3: { pairs: [], work: null }, 4: { pairs: [], work: null }, 5: { pairs: [], work: null }, 6: { pairs: [], work: null } },
        odd: { 1: { pairs: [], work: null }, 2: { pairs: [], work: null }, 3: { pairs: [], work: null }, 4: { pairs: [], work: null }, 5: { pairs: [], work: null }, 6: { pairs: [], work: null } }
      }
    };
    saveData(data);
  }
  return data[chatId];
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Настройка сессий
bot.use(session({
  initial: () => ({ step: null, week: null, day: null })
}));

const DAYS = { 1: 'Понедельник', 2: 'Вторник', 3: 'Среда', 4: 'Четверг', 5: 'Пятница', 6: 'Суббота' };

function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getDayScheduleForUser(chatId, targetDate = new Date()) {
  const userData = getUserData(chatId);
  const weekNum = getWeekNumber(targetDate);
  const isEven = weekNum % 2 === 0;
  const weekType = isEven ? 'even' : 'odd';
  const dayOfWeek = targetDate.getDay();

  return {
    weekNum,
    weekTypeLabel: isEven ? 'Четная' : 'Нечетная',
    dayData: userData.schedule[weekType]?.[dayOfWeek] || null
  };
}

function formatScheduleText(chatId, targetDate = new Date(), titlePrefix = 'сегодня') {
  const { weekNum, weekTypeLabel, dayData } = getDayScheduleForUser(chatId, targetDate);
  let text = `📅 **Расписание на ${titlePrefix}** (${weekTypeLabel} неделя №${weekNum}):\n\n`;

  if (!dayData || (!dayData.pairs?.length && !dayData.work)) {
    return text + '🎉 На этот день никаких пар и работы нет! Отдыхай.';
  }

  if (dayData.pairs && dayData.pairs.length > 0) {
    text += '📚 **Пары:**\n';
    dayData.pairs.forEach((p, idx) => {
      text += `${idx + 1}. **${p.time}** — ${p.name} (ауд. ${p.room})\n`;
    });
    text += '\n';
  } else {
    text += '📚 Пары: нет\n\n';
  }

  if (dayData.work) {
    text += `🛠 **Работа:**\n• **${dayData.work.name}**: ${dayData.work.time}\n`;
  }

  return text;
}

// Постоянная нижняя клавиатура
const mainKeyboard = new Keyboard()
  .text('📅 Сегодня').text('📆 Завтра').row()
  .text('⚙️ Настроить расписание')
  .resized();

// --- КОМАНДЫ И НАЖАТИЯ НИЖНИХ КНОПОК ---

bot.command('start', async (ctx) => {
  getUserData(ctx.chat.id);
  await ctx.reply(
    '👋 Привет! Добро пожаловать в бота расписания.\n\nИспользуй кнопки внизу для навигации:',
    { reply_markup: mainKeyboard }
  );
});

bot.hears('📅 Сегодня', async (ctx) => {
  await ctx.reply(formatScheduleText(ctx.chat.id, new Date(), 'сегодня'), { parse_mode: 'Markdown' });
});

bot.hears('📆 Завтра', async (ctx) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await ctx.reply(formatScheduleText(ctx.chat.id, tomorrow, 'завтра'), { parse_mode: 'Markdown' });
});

bot.hears('⚙️ Настроить расписание', async (ctx) => {
  ctx.session.step = null;
  const keyboard = new InlineKeyboard()
    .text('Четная неделя', 'week_even')
    .text('Нечетная неделя', 'week_odd');
  
  await ctx.reply('⚙️ **Выбери тип недели для редактирования:**', {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
});

// --- ИНЛАЙН НАВИГАЦИЯ И КНОПКИ ---

bot.callbackQuery(/^week_(even|odd)$/, async (ctx) => {
  const week = ctx.match[1];
  ctx.session.week = week;

  const keyboard = new InlineKeyboard();
  Object.entries(DAYS).forEach(([id, name]) => {
    keyboard.text(name, `day_${id}`).row();
  });
  keyboard.text('⬅️ Назад к выбору недели', 'back_to_weeks');

  await ctx.editMessageText(`Выбрана **${week === 'even' ? 'Четная' : 'Нечетная'} неделя**.\nВыбери день недели:`, {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('back_to_weeks', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('Четная неделя', 'week_even')
    .text('Нечетная неделя', 'week_odd');

  await ctx.editMessageText('⚙️ **Выбери тип недели:**', {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^day_(\d)$/, async (ctx) => {
  const day = ctx.match[1];
  ctx.session.day = day;

  const userData = getUserData(ctx.chat.id);
  const dayData = userData.schedule[ctx.session.week]?.[day] || { pairs: [], work: null };

  let text = `📅 **${DAYS[day]}** (${ctx.session.week === 'even' ? 'Четная' : 'Нечетная'} неделя)\n\n`;
  if (dayData.pairs && dayData.pairs.length > 0) {
    text += '📚 **Пары:**\n' + dayData.pairs.map((p, i) => `${i+1}. ${p.time} - ${p.name} (${p.room})`).join('\n') + '\n\n';
  } else {
    text += '📚 **Пары:** отсутствуют\n\n';
  }
  text += dayData.work ? `🛠 **Работа:** ${dayData.work.name} (${dayData.work.time})` : '🛠 **Работа:** нет';

  const keyboard = new InlineKeyboard()
    .text('➕ Добавить пару', 'add_pair').row()
    .text('🛠 Настроить работу', 'set_work').row()
    .text('🗑 Очистить день', 'clear_day').row()
    .text('⬅️ Назад к дням', `week_${ctx.session.week}`);

  await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('add_pair', async (ctx) => {
  ctx.session.step = 'awaiting_pair';
  await ctx.reply('Пришли пару в формате:\n`Время | Название | Аудитория`\n\nПример:\n`08:30-10:00 | Высшая математика | 304`', { parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('set_work', async (ctx) => {
  ctx.session.step = 'awaiting_work';
  await ctx.reply('Пришли смену в формате:\n`Время | Название`\n\nПример:\n`15:00-21:00 | Смена в мастерской`', { parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('clear_day', async (ctx) => {
  const data = loadData();
  if (data[ctx.chat.id]?.schedule[ctx.session.week]?.[ctx.session.day]) {
    data[ctx.chat.id].schedule[ctx.session.week][ctx.session.day] = { pairs: [], work: null };
    saveData(data);
  }
  await ctx.reply('✅ День очищен!');
  await ctx.answerCallbackQuery();
});

// Обработка текстового ввода
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;

  if (ctx.session.step === 'awaiting_pair') {
    const parts = ctx.message.text.split('|').map(s => s.trim());
    if (parts.length < 3) {
      return ctx.reply('⚠️ Неверный формат. Попробуй еще раз:\n`08:30-10:00 | Математика | 304`', { parse_mode: 'Markdown' });
    }

    const data = loadData();
    getUserData(chatId);
    data[chatId].schedule[ctx.session.week][ctx.session.day].pairs.push({
      time: parts[0],
      name: parts[1],
      room: parts[2]
    });

    saveData(data);
    ctx.session.step = null;
    await ctx.reply('✅ Пара добавлена!', { reply_markup: mainKeyboard });
  } 
  else if (ctx.session.step === 'awaiting_work') {
    const parts = ctx.message.text.split('|').map(s => s.trim());
    if (parts.length < 2) {
      return ctx.reply('⚠️ Неверный формат. Попробуй еще раз:\n`15:00-21:00 | Смена`', { parse_mode: 'Markdown' });
    }

    const data = loadData();
    getUserData(chatId);
    data[chatId].schedule[ctx.session.week][ctx.session.day].work = {
      time: parts[0],
      name: parts[1]
    };

    saveData(data);
    ctx.session.step = null;
    await ctx.reply('✅ Смена сохранена!', { reply_markup: mainKeyboard });
  }
});

// КРОН РАССЫЛКИ

cron.schedule('0 8 * * *', async () => {
  const data = loadData();
  const now = new Date();

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      try {
        const message = formatScheduleText(chatId, now, 'сегодня');
        await bot.api.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Ошибка утренней рассылки (${chatId}):`, err.message);
      }
    }
  }
});

cron.schedule('* * * * *', async () => {
  const data = loadData();
  const now = new Date();

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      const { dayData } = getDayScheduleForUser(chatId, now);

      if (dayData && dayData.work) {
        const startTimeStr = dayData.work.time.split('-')[0].trim();
        const [hours, minutes] = startTimeStr.split(':').map(Number);

        const shiftStartTime = new Date(now);
        shiftStartTime.setHours(hours, minutes, 0, 0);

        const diffInMinutes = Math.floor((shiftStartTime - now) / (1000 * 60));

        if (diffInMinutes === 60) {
          try {
            await bot.api.sendMessage(
              chatId,
              `⏰ **Напоминание!** Через 1 час смена: **${dayData.work.name}** (${dayData.work.time}).`,
              { parse_mode: 'Markdown' }
            );
          } catch (err) {
            console.error(`Ошибка напоминания (${chatId}):`, err.message);
          }
        }
      }
    }
  }
});

bot.catch((err) => {
  console.error('Ошибка:', err);
});

async function startBot() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {}

  console.log('🤖 Бот успешно запущен!');
  await bot.start();
}

startBot();