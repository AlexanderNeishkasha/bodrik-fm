/** Localized meeting status pages; technical details belong in diagnostics. */
export const MEETING_STATUS_COPY = {
  ru: {
    home: "На главную Бодрик FM", connecting: "Подключаемся…", retry: "Попробовать снова", rejoin: "Вернуться во встречу", takeBack: "Подключиться здесь",
    passwordLabel: "Пароль", submit: "Войти", wrongPassword: "Пароль не подошёл. Попробуйте ещё раз.",
    left: { title: "До встречи!", description: "Вы вышли. Если что — можно вернуться.", action: "rejoin" },
    failed: { title: "Не получилось подключиться", description: "Попробуем ещё раз?", action: "retry" },
    unavailable: { title: "Встреча недоступна", description: "Комната не найдена или встреча закрыта. Уточните ссылку у ведущего." },
    denied: { title: "Не получилось войти", description: "Уточните у ведущего, можно ли присоединиться." },
    kicked: { title: "Ведущий завершил ваше участие", description: "Вы больше не во встрече." },
    banned: { title: "Вход временно закрыт", description: "Ведущий заблокировал вам вход на 24 часа." },
    rejected: { title: "Вас не впустили", description: "Ведущий отклонил запрос на вход." },
    removed: { title: "Вы больше не во встрече", description: "Ваше участие завершено." },
    replaced: { title: "Встреча открыта в другом месте", description: "Вы подключились в другой вкладке или на другом устройстве.", action: "takeBack" },
    lobby: { title: "Скоро начнём", description: "Ждём, когда ведущий вас впустит." },
    password: { title: "Нужен пароль", description: "Его можно узнать у ведущего." },
    joinLocked: { title: "Вход в комнату закрыт", description: "Ведущий пока не принимает новых участников." },
    connectingPage: { title: "Подключаемся…", description: "Устанавливаем соединение со встречей.", action: "retry" },
  },
  en: {
    home: "Bodrik FM home", connecting: "Connecting…", retry: "Try again", rejoin: "Rejoin the meeting", takeBack: "Connect here",
    passwordLabel: "Password", submit: "Enter", wrongPassword: "That password didn't work. Try again.",
    left: { title: "See you!", description: "You've left. You're welcome to come back.", action: "rejoin" },
    failed: { title: "Couldn't connect", description: "Shall we try again?", action: "retry" },
    unavailable: { title: "Meeting unavailable", description: "The room is missing or the meeting is closed. Check the link with the presenter." },
    denied: { title: "Couldn't join", description: "Check with the presenter whether you can join." },
    kicked: { title: "The presenter ended your participation", description: "You're no longer in the meeting." },
    banned: { title: "Entry temporarily blocked", description: "The presenter blocked your access for 24 hours." },
    rejected: { title: "You weren't let in", description: "The presenter declined your request to join." },
    removed: { title: "You're no longer in the meeting", description: "Your participation has ended." },
    replaced: { title: "Meeting open elsewhere", description: "You connected in another tab or on another device.", action: "takeBack" },
    lobby: { title: "Starting soon", description: "Waiting for the presenter to let you in." },
    password: { title: "Password needed", description: "Ask the presenter for it." },
    joinLocked: { title: "Room closed to new arrivals", description: "The presenter isn't accepting new participants right now." },
    connectingPage: { title: "Connecting…", description: "Establishing a connection to the meeting.", action: "retry" },
  },
};

/** Resolve a status safely, with a connection failure as the unknown-state fallback. */
export function meetingStatusPage(status, language) {
  const text = MEETING_STATUS_COPY[language === "en" ? "en" : "ru"];
  const key = status === "connecting" ? "connectingPage" : status;
  return { text, page: Object.hasOwn(text, key) && typeof text[key] === "object" ? text[key] : text.failed };
}
