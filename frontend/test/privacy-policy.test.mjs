import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const policy = readFileSync(new URL("../app/privacy/page.js", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../compose.dev.yml", import.meta.url), "utf8");
const chatImages = readFileSync(
  new URL("../../backend/crates/meeting/src/replacement/uploads.rs", import.meta.url),
  "utf8",
);

for (const [name, pattern] of [
  ["SFU media processing", /MiroTalk SFU.*mediasoup/s],
  ["TURN relay", /TURN.*ретранслировать/s],
  ["transport encryption without an end-to-end claim", /не сквозное шифрование/],
  ["ephemeral chat", /Сам текст чата на диск\s+не записывается/],
  ["persistent avatars", /Загруженный аватар сохраняется на сервере/],
  ["temporary chat images", /автоматически удаляются примерно через 48 часов/],
  ["connection diagnostic fields", /никнейм, браузер, сервером увиденный IP/],
  ["diagnostic exclusions", /не включаются текст чата,[\s\S]*SDP, ICE-кандидаты/],
  ["self-hosted browser dependencies", /размещаются на серверах Бодрик FM/],
]) {
  test(`privacy policy covers ${name}`, () => assert.match(policy, pattern));
}

test("privacy retention matches local diagnostics and chat-image cleanup", () => {
  assert.match(policy, /не более 14 дней/);
  assert.match(compose, /REPLACEMENT_DIAGNOSTICS_RETENTION_DAYS: "14"/);
  assert.match(chatImages, /Duration::from_secs\(48 \* 60 \* 60\)/);
});

test("privacy policy does not repeat retired upstream behavior", () => {
  assert.doesNotMatch(policy, /Запись встречи|серверная запись|RTMP|Umami|публичным CDN|рекламн(?:ая|ым) аналитик/);
  assert.doesNotMatch(policy, /не обрабатывает содержимое звонка|сквозное шифрование между браузерами участников обеспечивается/);
});
