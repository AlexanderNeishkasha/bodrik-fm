import { expect } from "@playwright/test";

/** Assert real decoded video nodes, streams and tracks survive focus/panel relayouts. */
export async function checkStableFocus(page) {
  const region = page.getByRole("region", { name: "Участники встречи" });
  const originalViewport = page.viewportSize();
  await page.evaluate(() => {
    window.__focusProbe = new Map([...document.querySelectorAll("article[data-card-key]")].map((card) => {
      const video = card.querySelector("video");
      return [card.dataset.cardKey, video && { video, stream: video.srcObject, track: video.srcObject?.getVideoTracks()[0], clock: video.currentTime }];
    }).filter(([, video]) => video));
  });
  /** Check identity plus monotonic HTML playback clocks for every surviving source. */
  const verify = async () => {
    const state = await page.evaluate(() => [...window.__focusProbe].map(([key, before]) => {
      const card = [...document.querySelectorAll("article[data-card-key]")].find((node) => node.dataset.cardKey === key);
      const video = card?.querySelector("video");
      const result = { key, sameNode: video === before.video, sameStream: video?.srcObject === before.stream,
        sameTrack: video?.srcObject?.getVideoTracks()[0] === before.track, continuous: video?.currentTime >= before.clock, playing: video?.readyState >= 2 };
      before.clock = video?.currentTime;
      return result;
    }));
    expect(state.length).toBeGreaterThanOrEqual(3);
    for (const video of state) expect(video, video.key).toMatchObject({ sameNode: true, sameStream: true, sameTrack: true, continuous: true, playing: true });
  };
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const focused = region.locator('article[data-focused="true"]');
      if (await focused.count()) await focused.dblclick({ position: { x: 60, y: 60 } });
      await expect(region).toHaveAttribute("data-view", "grid");
      const camera = region.locator("article").filter({ has: page.locator("video") }).first();
      for (let cycle = 0; cycle < 20; cycle++) {
        await camera.dblclick({ position: { x: 60, y: 60 } });
        await expect(region).toHaveAttribute("data-view", "speaker");
        await page.waitForTimeout(350);
        await verify();
        // Horizontal thumbnail scrolling must leave the large card in the viewport.
        if (cycle === 0) {
          await region.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
          const bounds = await region.locator('article[data-focused="true"]').boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
          await region.evaluate((node) => { node.scrollLeft = 0; });
        }
        await camera.dblclick({ position: { x: 60, y: 60 } });
        await expect(region).toHaveAttribute("data-view", "grid");
        await page.waitForTimeout(350);
        await verify();
      }
      if (viewport.width > 600) {
        await camera.hover();
        await camera.getByRole("button", { name: "Во весь экран", exact: true }).click();
        await expect.poll(() => camera.evaluate((node) => document.fullscreenElement === node)).toBe(true);
        await camera.dblclick({ position: { x: 60, y: 60 } });
        await expect(camera).toHaveAttribute("data-focused", "true");
        expect(await camera.evaluate((node) => document.fullscreenElement === node)).toBe(true);
        await verify();
        await camera.getByRole("button", { name: "Выйти из полноэкранного режима", exact: true }).click();
        await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
        await camera.dblclick({ position: { x: 60, y: 60 } });
        await expect(region).toHaveAttribute("data-view", "grid");
        if (await page.evaluate(() => document.pictureInPictureEnabled)) {
          await camera.hover();
          await camera.getByRole("button", { name: "Картинка в картинке", exact: true }).click();
          await expect.poll(() => camera.evaluate((node) => document.pictureInPictureElement === node.querySelector("video"))).toBe(true);
          await camera.dblclick({ position: { x: 60, y: 60 } });
          await expect(camera).toHaveAttribute("data-focused", "true");
          expect(await camera.evaluate((node) => document.pictureInPictureElement === node.querySelector("video"))).toBe(true);
          await verify();
          await page.evaluate(() => document.exitPictureInPicture());
          await camera.dblclick({ position: { x: 60, y: 60 } });
          await expect(region).toHaveAttribute("data-view", "grid");
        }
      }
      const bar = page.getByRole("navigation", { name: "Управление встречей" });
      await bar.getByRole("button", { name: "Участники", exact: true }).click();
      await page.getByRole("button", { name: "Закрыть участников", exact: true }).click();
      await verify();
      await bar.getByRole("button", { name: "Чат", exact: true }).click();
      await page.getByRole("button", { name: "Закрыть чат", exact: true }).click();
      await verify();
      const avatar = region.locator('article[data-card-key="bodrik-music"]');
      await avatar.dblclick({ position: { x: 60, y: 60 } });
      await expect(avatar).toHaveAttribute("data-focused", "true");
      await verify();
      await avatar.dblclick({ position: { x: 60, y: 60 } });
      await expect(region).toHaveAttribute("data-view", "grid");
      await verify();
    }
  } finally {
    await page.evaluate(() => { delete window.__focusProbe; });
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
