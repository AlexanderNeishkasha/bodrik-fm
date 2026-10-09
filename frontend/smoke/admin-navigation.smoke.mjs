import { expect, test } from "@playwright/test";
import { adminNavigationFixture } from "./adminNavigationFixture.mjs";

let render;
test.use({ permissions: [] });
test.beforeAll(async () => { render = await adminNavigationFixture(); });

for (const { name, path, auth, target, label } of [
  { name: "admin header", path: "/puppet_master", target: "/", label: "К списку комнат" },
  { name: "admin Studio", path: "/studio?as=3", auth: { showAdminBack: true }, target: "/puppet_master", label: "К управлению пользователями" },
  { name: "ordinary Studio", path: "/studio", auth: { showAdminBack: false }, target: "/", label: "К списку комнат" },
  { name: "login screen", path: "/studio", auth: { isAuthed: false, isChecked: true }, target: "/", label: "К списку комнат" },
]) {
  test(`back arrow navigates correctly: ${name}`, async ({ page }) => {
    await page.route("http://admin-navigation.test/**", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url() === `http://admin-navigation.test${path}`
        ? (auth ? render.studio(auth) : render.admin()) : "<main>Navigation destination</main>",
    }));
    await page.goto(`http://admin-navigation.test${path}`);
    await expect(page.getByText("В админку", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Admin", exact: true })).toHaveCount(0);
    const back = page.getByRole("link", { name: label, exact: true });
    await expect(back).toHaveAttribute("href", target);
    await back.click();
    await expect(page).toHaveURL(`http://admin-navigation.test${target}`);
    await expect(page.getByText("Navigation destination", { exact: true })).toBeVisible();
  });
}
