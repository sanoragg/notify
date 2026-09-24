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
  "Проект (Ершов)"
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

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ВРЕМЕНИ И ДАТ (UTC+8 ИРКУТСК) ---

// Текущая дата/время по Иркутску
function getIrkutskDate(date = new Date()) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 8));
}

// Преобразование Date -> DD.MM.YYYY
function formatDateRU(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

// Преобразование DD.MM.YYYY -> YYYY-MM-DD (для хранения)
function parseRUDateToISO(ruDateStr) {
  const parts = ruDateStr.split('.');
  if (parts.length !== 3) return null;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

// Преобразование YYYY-MM-DD -> DD.MM.YYYY (для вывода)
function formatISOToRU(isoDateStr) {
  const parts = isoDateStr.split('-');
  if (parts.length !== 3) return isoDateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Определение четности недели (21.09.2026 - 27.09.2026 четная)
function isEvenWeek(targetDate = getIrkutskDate()) {
  // Базовый понедельник четной недели: 21.09.2026
  const anchorDate = new Date(2026, 8, 21); // Month is 0-indexed (8 = September)
  const diffTime = targetDate.getTime() - anchorDate.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 3600 * 24));
  const diffWeeks = Math.floor(diffDays / 7);
  
  // Если разница в неделях четная — неделя четная
  return Math.abs(diffWeeks) % 2 === 0;
}

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

// --- Пробки и погода в Иркутске ---
async function getIrkutskConditions() {
  let trafficScore = 4;
  let weatherDelay = 0;
  let weatherDesc = "ясно";

  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast?latitude=52.2978&longitude=104.2964&current_weather=true');
    if (res.data && res.data.current_weather) {
      const temp = res.data.current_weather.temperature;
      const weatherCode = res.data.current_weather.weathercode;

      if (temp < -20) {
        weatherDelay += 10;
        weatherDesc = `сильный мороз (${temp}°C)`;
      } else if (temp < -10) {
        weatherDelay += 5;
        weatherDesc = `морозно (${temp}°C)`;
      } else {
        weatherDesc = `${temp}°C`;
      }

      if ([71, 73, 75, 85, 86].includes(weatherCode)) {
        weatherDelay += 10;
        weatherDesc += ", снегопад";
      } else if ([61, 63, 65].includes(weatherCode)) {
        weatherDelay += 5;
        weatherDesc += ", дождь";
      }
    }
  } catch (e) {
    console.warn("Ошибка получения погоды:", e.message);
  }

  const hour = getIrkutskDate().getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) {
    trafficScore = 7;
  }

  return { trafficScore, weatherDelay, weatherDesc };
}

async function calculateDepartureTime(eventTimeStr, isWorkOnly = false) {
  const [hours, minutes] = eventTimeStr.split(':').map(Number);
  let totalEventMinutes = hours * 60 + minutes;

  if (isWorkOnly) {
    return totalEventMinutes - 20;
  }

  const { trafficScore, weatherDelay } = await getIrkutskConditions();

  let trafficDelay = 0;
  if (trafficScore >= 7) trafficDelay = 15;
  else if (trafficScore >= 5) trafficDelay = 8;

  const walkToStop = 6;
  const baseTravel = 25;
  const waitTime = (hours >= 7 && hours <= 9) ? 6 : 10;

  const totalTravelTime = walkToStop + waitTime + baseTravel + trafficDelay + weatherDelay;
  return totalEventMinutes - totalTravelTime;
}

function formatMinutesToTime(totalMinutes) {
  if (totalMinutes < 0) totalMinutes += 24 * 60;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// --- Построение СУХОГО отчёта ---
async function buildDailyReport(chatId, targetDate = getIrkutskDate(), isMorning = false) {
  const userData = getUserData(chatId);
  const isoDateStr = targetDate.toISOString().split('T')[0];
  const ruDateStr = formatDateRU(targetDate);
  const dayOfWeek = targetDate.getDay();
  
  const isEven = isEvenWeek(targetDate);
  const weekKey = isEven ? 'even' : 'odd';

  const classes = userData.schedule[weekKey]?.[dayOfWeek] || [];
  const workShift = userData.work?.[isoDateStr];
  const note = userData.notes?.[isoDateStr] || "нет";

  const { trafficScore, weatherDesc } = await getIrkutskConditions();

  let greeting = isMorning ? "доброе утро!" : `отчет на ${ruDateStr}:`;
  let lines = [`${greeting} сегодня следующие пары:`];

  let earliestTime = null;
  let isWorkOnly = false;

  if (classes.length > 0) {
    classes.forEach((p, idx) => {
      lines.push(`${idx + 1}. ${p.time} — ${p.subject} (ауд. ${p.room})`);
    });
    earliestTime = classes[0].time.split('-')[0].trim();
  } else {
    lines.push("нет");
  }

  if (workShift) {
    lines.push(`работа: ${workShift.start}`);
    if (!classes.length) {
      earliestTime = workShift.start.split('-')[0].trim();
      isWorkOnly = true;
    }
  } else {
    lines.push("работа: нет");
  }

  if (earliestTime) {
    const depMinutes = await calculateDepartureTime(earliestTime, isWorkOnly);
    const depTimeStr = formatMinutesToTime(depMinutes);
    lines.push(`выходить из дома в ${depTimeStr}`);
  } else {
    lines.push("выходить из дома: не требуется");
  }

  lines.push(`пробки: ${trafficScore} баллов`);
  lines.push(`погода: ${weatherDesc}`);
  lines.push(`взять с собой: ${note}`);

  return lines.join('\n');
}

function buildDayMenuTextAndKeyboard(chatId, week, day) {
  const userData = getUserData(chatId);
  const classes = userData.schedule[week]?.[day] || [];

  let text = `редактирование дня: ${DAYS[day]} (${week === 'even' ? 'четная' : 'нечетная'} неделя)\n\nтекущие пары:\n`;

  if (classes.length === 0) {
    text += 'нет';
  } else {
    classes.forEach((p, idx) => {
      text += `${idx + 1}. ${p.time} — ${p.subject} (ауд. ${p.room})\n`;
    });
  }

  const kb = new InlineKeyboard();
  kb.text('добавить пару', 'start_add_pair').row();

  if (classes.length > 0) {
    classes.forEach((p, idx) => {
      const shortTitle = p.subject.split('(')[0].trim();
      kb.text(`удалить: ${p.time} ${shortTitle}`, `delete_pair_${idx}`).row();
    });
    kb.text('очистить весь день', 'clear_entire_day').row();
  }

  kb.text('назад к выбору дней', `pair_week_${week}`);

  return { text, kb };
}

// Клавиатура
const mainKeyboard = new Keyboard()
  .text('сегодня').text('завтра').row()
  .text('отчет на завтра').row()
  .text('настроить пары').text('настроить работу').row()
  .text('заметка / вещи')
  .resized();

// --- КОМАНДА /start ---
bot.command('start', async (ctx) => {
  getUserData(ctx.chat.id);
  await ctx.reply('используй меню ниже для управления расписанием:', { reply_markup: mainKeyboard });
});

// --- КНОПКИ ГЛАВНОГО МЕНЮ ---
bot.hears('сегодня', async (ctx) => {
  const report = await buildDailyReport(ctx.chat.id, getIrkutskDate(), true);
  await ctx.reply(report);
});

bot.hears('завтра', async (ctx) => {
  const tomorrow = getIrkutskDate();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const report = await buildDailyReport(ctx.chat.id, tomorrow, false);
  await ctx.reply(report);
});

bot.hears('отчет на завтра', async (ctx) => {
  const tomorrow = getIrkutskDate();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const report = await buildDailyReport(ctx.chat.id, tomorrow, false);
  await ctx.reply(report);
});

// --- НАСТРОЙКА ПАР ---
bot.hears('настроить пары', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('четная неделя', 'pair_week_even')
    .text('нечетная неделя', 'pair_week_odd').row()
    .text('закрыть', 'close_menu');
  await ctx.reply('выбери тип недели:', { reply_markup: kb });
});

bot.callbackQuery(/^pair_week_(even|odd)$/, async (ctx) => {
  ctx.session.week = ctx.match[1];
  const kb = new InlineKeyboard();
  for (let id = 1; id <= 6; id++) {
    kb.text(DAYS[id], `pair_day_${id}`).row();
  }
  kb.text('назад', 'back_to_pair_weeks');
  await ctx.editMessageText(`выбрана ${ctx.session.week === 'even' ? 'четная' : 'нечетная'} неделя. выбери день:`, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('back_to_pair_weeks', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('четная неделя', 'pair_week_even')
    .text('нечетная неделя', 'pair_week_odd').row()
    .text('закрыть', 'close_menu');
  await ctx.editMessageText('выбери тип недели:', { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^pair_day_(\d)$/, async (ctx) => {
  ctx.session.day = ctx.match[1];
  const { text, kb } = buildDayMenuTextAndKeyboard(ctx.chat.id, ctx.session.week, ctx.session.day);
  await ctx.editMessageText(text, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

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
  await ctx.editMessageText(text, { reply_markup: kb });
  await ctx.answerCallbackQuery({ text: 'пара удалена' });
});

bot.callbackQuery('clear_entire_day', async (ctx) => {
  const data = loadData();
  const week = ctx.session.week;
  const day = ctx.session.day;

  if (data[ctx.chat.id]?.schedule?.[week]?.[day]) {
    data[ctx.chat.id].schedule[week][day] = [];
    saveData(data);
  }

  const { text, kb } = buildDayMenuTextAndKeyboard(ctx.chat.id, week, day);
  await ctx.editMessageText(text, { reply_markup: kb });
  await ctx.answerCallbackQuery({ text: 'день очищен' });
});

bot.callbackQuery('start_add_pair', async (ctx) => {
  const kb = new InlineKeyboard();
  SUBJECTS.forEach((subj, idx) => {
    kb.text(subj, `subj_select_${idx}`).row();
  });
  kb.text('назад', `pair_day_${ctx.session.day}`);
  await ctx.editMessageText('выбери предмет:', { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^subj_select_(\d+)$/, async (ctx) => {
  const subjIdx = parseInt(ctx.match[1]);
  ctx.session.tempSubject = SUBJECTS[subjIdx];

  const kb = new InlineKeyboard();
  TIMES.forEach((timeStr) => {
    kb.text(timeStr, `time_select_${timeStr}`).row();
  });
  kb.text('назад', 'start_add_pair');
  await ctx.editMessageText(`выбрано: ${ctx.session.tempSubject}\nвыбери время:`, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^time_select_(.+)$/, async (ctx) => {
  ctx.session.tempTime = ctx.match[1];
  ctx.session.step = 'awaiting_room';
  await ctx.reply(`время: ${ctx.session.tempTime}\nнапиши аудиторию (например 304):`);
  await ctx.answerCallbackQuery();
});

// --- РАБОТА И ЗАМЕТКИ ---
bot.hears('настроить работу', async (ctx) => {
  ctx.session.step = 'awaiting_work_date';
  await ctx.reply('введи дату работы в формате ДД.ММ.ГГГГ (например 25.09.2026):');
});

bot.hears('заметка / вещи', async (ctx) => {
  ctx.session.step = 'awaiting_note_date';
  await ctx.reply('введи дату в формате ДД.ММ.ГГГГ (например 25.09.2026):');
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

    await ctx.reply(`пара ${ctx.session.tempSubject} добавлена`);

    const { text, kb } = buildDayMenuTextAndKeyboard(chatId, week, day);
    await ctx.reply(text, { reply_markup: kb });
  } 
  else if (ctx.session.step === 'awaiting_work_date') {
    const ruDate = ctx.message.text.trim();
    const isoDate = parseRUDateToISO(ruDate);
    if (!isoDate) return ctx.reply('неверный формат. напиши дату как ДД.ММ.ГГГГ (например 25.09.2026):');

    ctx.session.dateStr = isoDate;
    ctx.session.step = 'awaiting_work_time';
    await ctx.reply('введи время работы (например 15:00-21:00 или 15:00):');
  }
  else if (ctx.session.step === 'awaiting_work_time') {
    const workTime = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    data[chatId].work[ctx.session.dateStr] = { start: workTime };
    saveData(data);
    ctx.session.step = null;
    await ctx.reply(`смена на ${formatISOToRU(ctx.session.dateStr)} (${workTime}) сохранена`, { reply_markup: mainKeyboard });
  }
  else if (ctx.session.step === 'awaiting_note_date') {
    const ruDate = ctx.message.text.trim();
    const isoDate = parseRUDateToISO(ruDate);
    if (!isoDate) return ctx.reply('неверный формат. напиши дату как ДД.ММ.ГГГГ (например 25.09.2026):');

    ctx.session.dateStr = isoDate;
    ctx.session.step = 'awaiting_note_text';
    await ctx.reply('напиши список вещей или заметку:');
  }
  else if (ctx.session.step === 'awaiting_note_text') {
    const noteText = ctx.message.text.trim();
    const data = loadData();
    getUserData(chatId);

    data[chatId].notes[ctx.session.dateStr] = noteText;
    saveData(data);
    ctx.session.step = null;
    await ctx.reply(`заметка на ${formatISOToRU(ctx.session.dateStr)} сохранена`, { reply_markup: mainKeyboard });
  }
});

// --- КРОН-РАССЫЛКИ С УЧЕТОМ ЧАСОВОГО ПОЯСА ИРКУТСКА (UTC+8) ---

// Вечерний отчет каждый день в 22:00 по Иркутску
cron.schedule('0 22 * * *', async () => {
  const data = loadData();
  const tomorrow = getIrkutskDate();
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      try {
        const report = await buildDailyReport(chatId, tomorrow, false);
        await bot.api.sendMessage(chatId, report);
      } catch (err) {
        console.error(`ошибка рассылки (${chatId}):`, err.message);
      }
    }
  }
}, { timezone: 'Asia/Irkutsk' });

// Утреннее напоминание за 1 час до выхода по Иркутску
cron.schedule('* * * * *', async () => {
  const data = loadData();
  const now = getIrkutskDate();
  const isoDateStr = now.toISOString().split('T')[0];
  const dayOfWeek = now.getDay();
  const isEven = isEvenWeek(now);
  const weekKey = isEven ? 'even' : 'odd';

  for (const chatId of Object.keys(data)) {
    if (data[chatId].subscribed) {
      const classes = data[chatId].schedule?.[weekKey]?.[dayOfWeek] || [];
      const workShift = data[chatId].work?.[isoDateStr];

      let earliestTime = null;
      let isWorkOnly = false;

      if (classes.length > 0) {
        earliestTime = classes[0].time.split('-')[0].trim();
      } else if (workShift) {
        earliestTime = workShift.start.split('-')[0].trim();
        isWorkOnly = true;
      }

      if (earliestTime) {
        const depMinutes = await calculateDepartureTime(earliestTime, isWorkOnly);
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        if (depMinutes - currentMinutes === 60) {
          try {
            const note = data[chatId].notes?.[isoDateStr] || 'нет';
            await bot.api.sendMessage(
              chatId,
              `доброе утро! до выхода из дома остался 1 час.\nвзять с собой: ${note}`
            );
          } catch (err) {
            console.error(`ошибка напоминания (${chatId}):`, err.message);
          }
        }
      }
    }
  }
}, { timezone: 'Asia/Irkutsk' });

async function startBot() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setMyCommands([]);
  } catch (e) {}

  console.log('бот запущен (сухой отчет, Иркутск UTC+8, даты DD.MM.YYYY)');
  await bot.start();
}

startBot();