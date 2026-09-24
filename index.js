require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_FILE = path.join(__dirname, 'schedule.json');

// --- Справочники ---
const SUBJECTS = [
  "ПЛК в системах управления (Бурмалдакин)",
  "Автоматизация в нефтегазе (Ершов)",
  "Управление качеством(Анжеличка)",
  "Правоведение(Андреев)",
  "Проектирование(Колодин)",
  "Программирование(Колодин)",
  "Моделирование(Голодков)",
  "Автоматизация в нефтегазе(Мельник)",
  "БЖД(Тюкалова)",
  "Проектирование(никитос)",
  "Проект (Ершов)" // <--- Добавленная пара
];

const TIMES = [
  "8:15-9:45",
  "10:00-11:30",
  "11:45-13:15",
  "13:45-15:15",
  "15:30-17:00",
  "17:10-18:40",
  "18:45-20:15"
];

const DAYS = { 1: 'Понедельник', 2: 'Вторник', 3: 'Среда', 4: 'Четверг', 5: 'Пятница', 6: 'Суббота', 0: 'Воскресенье' };

// --- БД ---
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
        even: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
        odd: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
      },
      work: {},
      notes: {}
    };
    saveData(data);
  }
  return data[chatId];
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
  initial: () => ({ step: null, week: null, day: null, tempSubject: null, tempTime: null, dateStr: null })
}));

function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// --- Интеграция Погоды и Пробок в Иркутске ---
async function getIrkutskConditions() {
  let trafficScore = 4;
  let weatherDelay = 0;
  let weatherDesc = "Ясно / Умеренно";

  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast?latitude=52.2978&longitude=104.2964&current_weather=true');
    if (res.data && res.data.current_weather) {
      const temp = res.data.current_weather.temperature;
      const weatherCode = res.data.current_weather.weathercode;

      if (temp < -20) {
        weatherDelay += 10;
        weatherDesc = `Сильный мороз (${temp}°C)`;
      } else if (temp < -10) {
        weatherDelay += 5;
        weatherDesc = `Морозно (${temp}°C)`;
      }

      if ([71, 73, 75, 85, 86].includes(weatherCode)) {
        weatherDelay += 10;
        weatherDesc += ", Снегопад ❄️";
      } else if ([61, 63, 65].includes(weatherCode)) {
        weatherDelay += 5;
        weatherDesc += ", Дождь 🌧";
      }
    }
  } catch (e) {
    console.warn("Не удалось получить погоду:", e.message);
  }

  const hour = new Date().getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) {
    trafficScore = 7;
  }

  return { trafficScore, weatherDelay, weatherDesc };
}

async function calculateDepartureTime(eventTimeStr, isWorkOnly = false) {
  const [hours, minutes] = eventTimeStr.split(':').map(Number);
  let totalEventMinutes = hours * 60 + minutes;

  if (isWorkOnly) {
    return {
      depMinutes: totalEventMinutes - 20,
      details: "20 минут пешком до работы"
    };
  }

  const { trafficScore, weatherDelay, weatherDesc } = await getIrkutskConditions();

  let trafficDelay = 0;
  if (trafficScore >= 7) trafficDelay = 15;
  else if (trafficScore >= 5) trafficDelay = 8;

  const walkToStop = 6;
  const baseTravel = 25;
  const waitTime = (hours >= 7 && hours <= 9) ? 6 : 10;

  const totalTravelTime = walkToStop + waitTime + baseTravel + trafficDelay + weatherDelay;
  const depMinutes = totalEventMinutes - totalTravelTime;

  const details = `6 мин до остановки + ${baseTravel + trafficDelay} мин в пути (маршруты 80, 3, 18, 55, 57, пробки: ${trafficScore}/10) + погода: ${weatherDesc}`;

  return { depMinutes, details };
}

function formatMinutesToTime(totalMinutes) {
  if (totalMinutes < 0) totalMinutes += 24 * 60;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Построение отчёта
async function buildDailyReport(chatId, targetDate = new Date()) {
  const userData = getUserData(chatId);
  const dateStr = targetDate.toISOString().split('T')[0];
  const dayOfWeek = targetDate.getDay();
  
  const weekNum = getWeekNumber(targetDate);
  const isEven = weekNum % 2 === 0;
  const weekKey = isEven ? 'even' : 'odd';

  const classes = userData.schedule[weekKey]?.[dayOfWeek] || [];
  const workShift = userData.work?.[dateStr];
  const note = userData.notes?.[dateStr];

  let text = `📋 **Расписание на ${dateStr} (${DAYS[dayOfWeek]})**:\n\n`;

  let earliestTime = null;
  let isWorkOnly = false;

  if (classes.length > 0) {
    text += '📚 **Пары:**\n';
    classes.forEach((p, idx) => {
      text += `${idx + 1}. **${p.time}** — ${p.subject} (ауд. ${p.room})\n`;
    });
    text += '\n';
    earliestTime = classes[0].time.split('-')[0].trim();
  } else {
    text += '📚 **Пары:** нет\n\n';
  }

  if (workShift) {
    text += `🛠 **Работа:** начало в **${workShift.start}**\n\n`;
    if (!classes.length) {
      earliestTime = workShift.start;
      isWorkOnly = true;
    }
  } else {
    text += '🛠 **Работа:** нет\n\n';
  }

  if (earliestTime) {
    const { depMinutes, details } = await calculateDepartureTime(earliestTime, isWorkOnly);
    const depTimeStr = formatMinutesToTime(depMinutes);
    text += `🚶‍♂️ **Время выхода из дома:** \`${depTimeStr}\`\n`;
    text += `_(${details})_\n`;
  } else {
    text += '🎉 Полностью свободный день!\n';
  }

  if (note) {
    text += `\n🎒 **Заметка (что взять с собой):**\n${note}\n`;
  }

  return text;
}

// Вспомогательная функция для отображения меню конкретного дня
function buildDayMenuTextAndKeyboard(chatId, week, day) {
  const userData = getUserData(chatId);
  const classes = userData.schedule[week]?.[day] || [];

  let text = `📅 **Редактирование дня: ${DAYS[day]}** (${week === 'even' ? 'Четная' : 'Нечетная'} неделя)\n\n`;

  if (classes.length === 0) {
    text += '📚 На этот день нет запланированных пар.';
  } else {
    text += '📚 **Текущие пары:**\n';
    classes.forEach((p, idx) => {
      text += `${idx + 1}. **${p.time}** — ${p.subject} (ауд. ${p.room})\n`;
    });
  }

  const kb = new InlineKeyboard();
  kb.text('➕ Добавить пару', 'start_add_pair').row();

  if (classes.length > 0) {
    // Выборочное удаление каждой пары
    classes.forEach((p, idx) => {
      const shortTitle = p.subject.split('(')[0].trim();
      kb.text(`❌ Удалить: ${p.time} ${shortTitle}`, `delete_pair_${idx}`).row();
    });
    kb.text('🗑 Очистить весь день', 'clear_entire_day').row();
  }

  kb.text('⬅️ Назад к выбору дней', `pair_week_${week}`);

  return { text, kb };
}

// Главная клавиатура
const mainKeyboard = new Keyboard()
  .text('📅 Сегодня').text('📆 Завтра').row()
  .text('📊 Отчет на завтра (детальный)').row()
  .text('📚 Настроить пары').text('💼 Настроить работу').row()
  .text('📝 Заметка / Вещи')
  .resized();

// --- КОМАНДА /start ---
bot.command('start', async (ctx) => {
  getUserData(ctx.chat.id);
  await ctx.reply(
    '👋 Привет! Используй меню ниже для управления расписанием:',
    { reply_markup: mainKeyboard }
  );
});

// --- НАЖАТИЯ НИЖНИХ КНОПОК ---
bot.hears('📅 Сегодня', async (ctx) => {
  const report = await buildDailyReport(ctx.chat.id, new Date());
  await ctx.reply(report, { parse_mode: 'Markdown' });
});

bot.hears('📆 Завтра', async (ctx) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const report = await buildDailyReport(ctx.chat.id, tomorrow);
  await ctx.reply(report, { parse_mode: 'Markdown' });
});

bot.hears('📊 Отчет на завтра (детальный)', async (ctx) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const report = await buildDailyReport(ctx.chat.id, tomorrow);
  await ctx.reply(`📊 **Запрошенный отчет на завтра:**\n\n${report}`, { parse_mode: 'Markdown' });
});

// --- НАСТРОЙКА ПАР ---
bot.hears('📚 Настроить пары', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('Четная неделя', 'pair_week_even')
    .text('Нечетная неделя', 'pair_week_odd').row()
    .text('❌ Закрыть', 'close_menu');
  await ctx.reply('⚙️ Выбери тип недели для пар:', { reply_markup: kb });
});

bot.callbackQuery(/^pair_week_(even|odd)$/, async (ctx) => {
  ctx.session.week = ctx.match[1];
  const kb = new InlineKeyboard();
  for (let id = 1; id <= 6; id++) {
    kb.text(DAYS[id], `pair_day_${id}`).row();
  }
  kb.text('⬅️ Назад', 'back_to_pair_weeks');
  await ctx.editMessageText(`Выбрана **${ctx.session.week === 'even' ? 'Четная' : 'Нечетная'} неделя**. Выбери день:`, {
    reply_markup: kb,
    parse_mode: 'Markdown'
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('back_to_pair_weeks', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('Четная неделя', 'pair_week_even')
    .text('Нечетная неделя', 'pair_week_odd').row()
    .text('❌ Закрыть', 'close_menu');
  await ctx.editMessageText('⚙️ Выбери тип недели:', { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// Экран конкретного дня с просмотром и удалением
bot.callbackQuery(/^pair_day_(\d)$/, async (ctx) => {
  ctx.session.day = ctx.match[1];
  const { text, kb } = buildDayMenuTextAndKeyboard(ctx.chat.id, ctx.session.week, ctx.session.day);
  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

// Удаление выбранной пары
bot.callbackQuery(/^delete_pair_(\d+)$/, async (ctx) => {
  const pairIdx = parseInt(ctx.match[1]);
  const data = loadData();
  const week = ctx.session.week;
  const day = ctx.session.day;

  if (data[ctx.chat.id]?.schedule?.[week]?.[day]) {
    data[ctx.chat.id].schedule[week][day].splice(pairIdx, 1);
    saveData(data);
  }

  const { text, kb } = buildDayMenuTextAndKeyboard(ctx.chat.id, week, day);
  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery({ text: 'Пара удалена' });
});

// Очистка всех пар за день
bot.callbackQuery('clear_entire_day', async (ctx) => {
  const data = loadData();
  const week = ctx.session.week;
  const day = ctx.session.day;

  if (data[ctx.chat.id]?.schedule?.[week]?.[day]) {
    data[ctx.chat.id].schedule[week][day] = [];
    saveData(data);
  }

  const { text, kb } = buildDayMenuTextAndKeyboard(ctx.chat.id, week, day);
  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery({ text: 'Все пары на день очищены' });
});

// Начало добавления пары
bot.callbackQuery('start_add_pair', async (ctx) => {
  const kb = new InlineKeyboard();
  SUBJECTS.forEach((subj, idx) => {
    kb.text(subj, `subj_select_${idx}`).row();
  });
  kb.text('⬅️ Назад', `pair_day_${ctx.session.day}`);
  await ctx.editMessageText('📚 Выбери **пара / преподаватель**:', { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^subj_select_(\d+)$/, async (ctx) => {
  const subjIdx = parseInt(ctx.match[1]);
  ctx.session.tempSubject = SUBJECTS[subjIdx];

  const kb = new InlineKeyboard();
  TIMES.forEach((timeStr) => {
    kb.text(timeStr, `time_select_${timeStr}`).row();
  });
  kb.text('⬅️ Назад', 'start_add_pair');
  await ctx.editMessageText(`Выбрано: **${ctx.session.tempSubject}**\n\nВыбери время пары:`, { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^time_select_(.+)$/, async (ctx) => {
  ctx.session.tempTime = ctx.match[1];
  ctx.session.step = 'awaiting_room';
  await ctx.reply(`Время: **${ctx.session.tempTime}**\n\nНапиши аудиторию (например \`304\` или \`А-12\`):`, { parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

// --- РАБОТА И ЗАМЕТКИ ---
bot.hears('💼 Настроить работу', async (ctx) => {
  ctx.session.step = 'awaiting_work_date';
  await ctx.reply('💼 Введи дату работы в формате **ГГГГ-ММ-ДД** (например, `2026-09-26`):', { parse_mode: 'Markdown' });
});

bot.hears('📝 Заметка / Вещи', async (ctx) => {
  ctx.session.step = 'awaiting_note_date';
  await ctx.reply('📝 Введи дату для заметки в формате **ГГГГ-ММ-ДД** (например, `2026-09-26`):', { parse_mode: 'Markdown' });
});

bot.callbackQuery('close_menu', async (ctx) => {
  await ctx.deleteMessage();
  await ctx.answerCallbackQuery();
});

// --- ТЕКСТОВЫЙ ВВОД ---
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;

  if (ctx.session.step === 'awaiting_room') {
    const room = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    const week = ctx.session.week;
    const day = ctx.session.day;

    data[chatId].schedule[week][day].push({
      subject: ctx.session.tempSubject,
      time: ctx.session.tempTime,
      room: room
    });

    saveData(data);
    ctx.session.step = null;

    await ctx.reply(`✅ Пара **${ctx.session.tempSubject}** добавлена!`);

    // Возвращаем пользователя обратно в меню редактирования текущего дня
    const { text, kb } = buildDayMenuTextAndKeyboard(chatId, week, day);
    await ctx.reply(text, { reply_markup: kb, parse_mode: 'Markdown' });
  } 
  else if (ctx.session.step === 'awaiting_work_date') {
    ctx.session.dateStr = ctx.message.text.trim();
    ctx.session.step = 'awaiting_work_time';
    await ctx.reply('Введи время начала смены в формате **ЧЧ:ММ** (например, `15:00`):', { parse_mode: 'Markdown' });
  }
  else if (ctx.session.step === 'awaiting_work_time') {
    const workTime = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    data[chatId].work[ctx.session.dateStr] = { start: workTime };
    saveData(data);
    ctx.session.step = null;
    await ctx.reply(`✅ Смена на **${ctx.session.dateStr}** в **${workTime}** сохранена!`, { reply_markup: mainKeyboard });
  }
  else if (ctx.session.step === 'awaiting_note_date') {
    ctx.session.dateStr = ctx.message.text.trim();
    ctx.session.step = 'awaiting_note_text';
    await ctx.reply('Напиши список вещей или заметку на этот день:', { parse_mode: 'Markdown' });
  }
  else if (ctx.session.step === 'awaiting_note_text') {
    const noteText = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    data[chatId].notes[ctx.session.dateStr] = noteText;
    saveData(data);
    ctx.session.step = null;
    await ctx.reply(`✅ Заметка на **${ctx.session.dateStr}** сохранена!`, { reply_markup: mainKeyboard });
  }
});

// --- КРОН РАССЫЛКИ ---
cron.schedule('0 22 * * *', async () => {
  const data = loadData();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      try {
        const report = await buildDailyReport(chatId, tomorrow);
        await bot.api.sendMessage(chatId, `🌆 **Вечерний отчёт на завтра (22:00)**\n\n${report}`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Ошибка отправки вечернего отчета (${chatId}):`, err.message);
      }
    }
  }
});

cron.schedule('* * * * *', async () => {
  const data = loadData();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const dayOfWeek = now.getDay();
  const weekNum = getWeekNumber(now);
  const weekKey = weekNum % 2 === 0 ? 'even' : 'odd';

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      const classes = data[chatId].schedule?.[weekKey]?.[dayOfWeek] || [];
      const workShift = data[chatId].work?.[dateStr];

      let earliestTime = null;
      let isWorkOnly = false;

      if (classes.length > 0) {
        earliestTime = classes[0].time.split('-')[0].trim();
      } else if (workShift) {
        earliestTime = workShift.start;
        isWorkOnly = true;
      }

      if (earliestTime) {
        const { depMinutes } = await calculateDepartureTime(earliestTime, isWorkOnly);
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        if (depMinutes - currentMinutes === 60) {
          try {
            const note = data[chatId].notes?.[dateStr] || 'Ничего специального';
            await bot.api.sendMessage(
              chatId,
              `⏰ **Утреннее напоминание!** До выхода из дома остался 1 час!\n\n🎒 **Не забудь взять с собой:**\n${note}`,
              { parse_mode: 'Markdown' }
            );
          } catch (err) {
            console.error(`Ошибка утреннего напоминания (${chatId}):`, err.message);
          }
        }
      }
    }
  }
});

async function startBot() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setMyCommands([]);
  } catch (e) {}

  console.log('🤖 Запущен бот с улучшенным меню пар и мгновенным возвратом в контекст дня!');
  await bot.start();
}

startBot();