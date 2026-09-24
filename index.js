require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

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
  "Проектирование(никитос)"
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

// --- Работа с БД ---
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
      work: {}, // {"YYYY-MM-DD": { start: "15:00" }}
      notes: {} // {"YYYY-MM-DD": "текст"}
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

// Расчёт времени выхода (маршруты 80, 3, 18, 55, 57 Иркутска)
function calculateDepartureTime(eventTimeStr, isWorkOnly = false) {
  const [hours, minutes] = eventTimeStr.split(':').map(Number);
  let totalEventMinutes = hours * 60 + minutes;

  if (isWorkOnly) {
    // 20 минут пешком
    return totalEventMinutes - 20;
  } else {
    // Учёба: 6 мин пешком до остановки + ожидания (в пик ~6 мин, не пик ~12 мин) + дорога (~25 мин)
    let waitTime = (hours >= 7 && hours <= 9) || (hours >= 17 && hours <= 19) ? 6 : 12;
    let travelTime = 6 + waitTime + 25;
    return totalEventMinutes - travelTime;
  }
}

function formatMinutesToTime(totalMinutes) {
  if (totalMinutes < 0) totalMinutes += 24 * 60;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Построение отчёта на конкретную дату
function buildDailyReport(chatId, targetDate = new Date()) {
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
    const depMinutes = calculateDepartureTime(earliestTime, isWorkOnly);
    const depTimeStr = formatMinutesToTime(depMinutes);
    text += `🚶‍♂️ **Время выхода из дома:** \`${depTimeStr}\`\n`;
    text += isWorkOnly 
      ? `_(Рассчитано: 20 минут пешком до работы)_\n` 
      : `_(Рассчитано: 6 мин до остановки + общественный транспорт Иркутска №80, 3, 18, 55, 57)_\n`;
  } else {
    text += '🎉 Полностью свободный день!\n';
  }

  if (note) {
    text += `\n🎒 **Заметка (что взять с собой):**\n${note}\n`;
  }

  return text;
}

// Главная нижняя клавиатура
const mainKeyboard = new Keyboard()
  .text('📅 Сегодня').text('📆 Завтра').row()
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
  await ctx.reply(buildDailyReport(ctx.chat.id, new Date()), { parse_mode: 'Markdown' });
});

bot.hears('📆 Завтра', async (ctx) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await ctx.reply(buildDailyReport(ctx.chat.id, tomorrow), { parse_mode: 'Markdown' });
});

// --- ДОБАВЛЕНИЕ ПАР ---
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

bot.callbackQuery(/^pair_day_(\d)$/, async (ctx) => {
  ctx.session.day = ctx.match[1];
  const kb = new InlineKeyboard();
  SUBJECTS.forEach((subj, idx) => {
    kb.text(subj, `subj_select_${idx}`).row();
  });
  kb.text('⬅️ Назад', `pair_week_${ctx.session.week}`);
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
  kb.text('⬅️ Назад', `pair_day_${ctx.session.day}`);
  await ctx.editMessageText(`Выбрано: **${ctx.session.tempSubject}**\n\nВыбери время пары:`, { reply_markup: kb, parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^time_select_(.+)$/, async (ctx) => {
  ctx.session.tempTime = ctx.match[1];
  ctx.session.step = 'awaiting_room';
  await ctx.reply(`Время: **${ctx.session.tempTime}**\n\nНапиши аудиторию (например \`304\` или \`А-12\`):`, { parse_mode: 'Markdown' });
  await ctx.answerCallbackQuery();
});

// --- НАСТРОЙКА РАБОТЫ (ОТДЕЛЬНО НА ДНИ) ---
bot.hears('💼 Настроить работу', async (ctx) => {
  ctx.session.step = 'awaiting_work_date';
  await ctx.reply('💼 Введи дату работы в формате **ГГГГ-ММ-ДД** (например, `2026-09-26`):', { parse_mode: 'Markdown' });
});

// --- ЗАМЕТКА / ВЕЩИ ---
bot.hears('📝 Заметка / Вещи', async (ctx) => {
  ctx.session.step = 'awaiting_note_date';
  await ctx.reply('📝 Введи дату для заметки в формате **ГГГГ-ММ-ДД** (например, `2026-09-26`):', { parse_mode: 'Markdown' });
});

bot.callbackQuery('close_menu', async (ctx) => {
  await ctx.deleteMessage();
  await ctx.answerCallbackQuery();
});

// --- ТЕКСТОВЫЙ ВВОД (АУДИТОРИЯ, ДАТЫ, ЗАМЕТКИ) ---
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;

  if (ctx.session.step === 'awaiting_room') {
    const room = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    data[chatId].schedule[ctx.session.week][ctx.session.day].push({
      subject: ctx.session.tempSubject,
      time: ctx.session.tempTime,
      room: room
    });

    saveData(data);
    ctx.session.step = null;
    await ctx.reply(`✅ Пара **${ctx.session.tempSubject}** (${ctx.session.tempTime}, ауд. ${room}) добавлена!`, { reply_markup: mainKeyboard });
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

// --- КРОН-РАССЫЛКИ (ВЕЧЕР В 22:00 И УТРОМ ЗА 1 ЧАС ДО ВЫХОДА) ---

// Каждый вечер в 22:00
cron.schedule('0 22 * * *', async () => {
  const data = loadData();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      try {
        const report = buildDailyReport(chatId, tomorrow);
        await bot.api.sendMessage(chatId, `🌆 **Вечерний отчёт на завтра (22:00)**\n\n${report}`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Ошибка отправки вечернего отчета (${chatId}):`, err.message);
      }
    }
  }
});

// Проверка утреннего уведомления (за 1 час до выхода)
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
        const depMinutes = calculateDepartureTime(earliestTime, isWorkOnly);
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        // Если до выхода остался ровно 60 минут
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

  console.log('🤖 Обновленный бот успешно запущен!');
  await bot.start();
}

startBot();