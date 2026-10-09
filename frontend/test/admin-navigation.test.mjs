import test from "node:test";
import assert from "node:assert/strict";
import { adminNavigationFixture } from "../smoke/adminNavigationFixture.mjs";

const render = await adminNavigationFixture();

for (const { name, auth, target, label } of [
  { name: "admin session", auth: { showAdminBack: true }, target: "/puppet_master", label: "К управлению пользователями" },
  { name: "admin viewing another user without account controls", auth: { showAdminBack: true, canManageAccount: false }, target: "/puppet_master", label: "К управлению пользователями" },
  { name: "ordinary user", auth: { showAdminBack: false }, target: "/", label: "К списку комнат" },
  { name: "missing admin flag", auth: {}, target: "/", label: "К списку комнат" },
  { name: "unauthenticated login", auth: { isAuthed: false, isChecked: true, showAdminBack: true }, target: "/", label: "К списку комнат" },
]) {
  test(`Studio back navigation: ${name}`, () => {
    const html = render.studio(auth);
    assert.match(html, new RegExp(`aria-label="${label}"[^>]*href="${target}"`));
    assert.ok(!html.includes("В админку"));
    assert.equal((html.match(/href="\/puppet_master"/g) || []).length, target === "/puppet_master" ? 1 : 0);
  });
}

test("admin header replaces Admin heading with an accessible home arrow and keeps logout", () => {
  const html = render.admin();
  assert.match(html, /aria-label="К списку комнат"[^>]*href="\/"/);
  assert.ok(!html.includes(">Admin</h1>"));
  assert.ok(html.includes("Выйти"));
  assert.ok(html.includes('aria-hidden="true"'));
});
