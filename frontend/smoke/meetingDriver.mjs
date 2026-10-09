/** UI actions for the meeting smoke test, at the public `/room/{slug}` URL. */

/** Headless-client meeting: actions go through the React control bar. */
export function nextDriver(page) {
  const bar = page.getByRole("navigation", { name: "Управление встречей" });
  return {
    /** Path that opens this UI for a room (the public invitation URL). */
    path: (room) => `/room/${encodeURIComponent(room)}`,
    /** Fill the prejoin name and join, explicitly enabling video only when requested. */
    async join(name, { video = false } = {}) {
      if (video) await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
      await page.getByRole("textbox", { name: "Введите имя" }).fill(name);
      await page.getByRole("button", { name: "Присоединиться к встрече" }).click();
      await page.locator("main[data-meeting-status=admitted]").waitFor();
    },
    /** Toggle the local microphone. */
    async toggleMicrophone() {
      await bar.getByRole("button", { name: /^(Выключить|Включить) микрофон$/ }).click();
    },
    /** Toggle the local camera. */
    async toggleCamera() {
      await bar.getByRole("button", { name: /^(Выключить|Включить) камеру$/ }).click();
    },
    /** Toggle the chat panel; call once to open it. */
    async openChat() {
      await bar.getByRole("button", { name: "Чат", exact: true }).click();
    },
    /** Leave; a presenter with others present chooses "leave" from the exit menu. */
    async leave() {
      // Open side panels cover the control bar; close them first.
      for (const name of ["Закрыть чат", "Закрыть участников"]) {
        const close = page.getByRole("button", { name, exact: true });
        if (await close.isVisible().catch(() => false)) await close.click();
      }
      await bar.getByRole("button", { name: "Покинуть встречу" }).click();
      const leaveSelf = page.getByRole("menuitem", { name: "Выйти из встречи" });
      if (await leaveSelf.isVisible().catch(() => false)) await leaveSelf.click();
    },
  };
}
