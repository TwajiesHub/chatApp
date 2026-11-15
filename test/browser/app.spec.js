import { test, expect } from "@playwright/test";
async function signup(page, name) {
  await page.goto("/");
  await page.locator("[name=username]").fill(name);
  await page.locator("[name=password]").fill("test-password-123");
  await page
    .locator("#auth-form [name=name]")
    .fill(name === "ada" ? "Ada Okafor" : name);
  await page.locator("#auth-submit").click();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#connection-text")).toContainText("Connected");
}
async function chat(page, text) {
  await page.locator("#message-input").fill(text);
  await page.locator(".send-button").click();
  await expect(page.locator("#messages")).toContainText(text);
}
test("two students chat, focus, call, adapt controls, download and return offline", async ({
  browser,
}) => {
  const a = await browser.newContext({ permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ permissions: ["camera", "microphone"] });
  const ada = await a.newPage();
  const bayo = await b.newPage();
  const errors = [];
  ada.on("pageerror", (e) => errors.push(e.message));
  bayo.on("pageerror", (e) => errors.push(e.message));
  const suffix = Date.now().toString().slice(-8);
  await signup(ada, "ada" + suffix);
  await signup(bayo, "bayo" + suffix);
  await chat(ada, "Can we revise quadratic equations?");
  await expect(bayo.locator("#messages")).toContainText(
    "Can we revise quadratic equations?",
  );
  await chat(bayo, "Yes! Let’s work through one together.");
  await expect(ada.locator("#messages")).toContainText("Let’s work through");
  await ada.locator("#timer-button").click();
  await expect(bayo.locator("#timer-button")).toContainText("End session");
  for (const p of [ada, bayo]) {
    await p.locator("#prepare-call").click();
    await expect(p.locator("#pre-estimate")).toContainText("28 MB");
    await p.locator("#join-call").click();
    await expect(p.locator("#call-panel")).toBeVisible();
  }
  await expect(ada.locator("#video-grid .video-tile")).toHaveCount(2);
  await expect(bayo.locator("#call-status")).toContainText("connected", {
    timeout: 20000,
  });
  await expect
    .poll(() =>
      ada
        .locator("#video-grid video")
        .nth(1)
        .evaluate((v) => v.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await ada.locator("#toggle-video").click();
  await expect(ada.locator("#toggle-video")).toHaveText("Enable video");
  await ada.locator("#low-data").uncheck();
  ada.once("dialog", (d) => d.accept());
  await ada.locator("#live-quality").selectOption("medium");
  ada.once("dialog", (d) => d.accept());
  await ada.locator("#toggle-video").click();
  await expect(ada.locator("#toggle-video")).toHaveText("Voice only");
  await ada.locator("#toggle-mic").click();
  await expect(ada.locator("#toggle-mic")).toHaveText("Unmute");
  await ada.locator("#leave-call").click();
  await bayo.locator("#leave-call").click();
  await ada.locator("#file-input").setInputFiles({
    name: "revision.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 revision notes"),
  });
  await ada.locator(".send-button").click();
  await expect(
    bayo.locator("#messages button").filter({ hasText: "revision.pdf" }),
  ).toBeVisible();
  const download = bayo.waitForEvent("download");
  await bayo
    .locator("#messages button")
    .filter({ hasText: "revision.pdf" })
    .click();
  await download;
  await bayo.locator("[data-page=resources]").click();
  await expect(bayo.locator("#resource-list")).toContainText("revision.pdf");
  await bayo.evaluate(() => navigator.serviceWorker.ready);
  await b.setOffline(true);
  await bayo.reload();
  await expect(bayo.locator("#app")).toBeVisible();
  await expect(bayo.locator("#messages")).toContainText("quadratic");
  await chat(bayo, "Saved offline question");
  await expect(bayo.locator("#messages")).toContainText("Waiting to send");
  await b.setOffline(false);
  await expect(ada.locator("#messages")).toContainText(
    "Saved offline question",
    { timeout: 20000 },
  );
  await bayo.locator("[data-page=chats]").click();
  await bayo.locator("#new-chat").click();
  await bayo.locator("#new-chat-form [name=name]").fill("Maths partners");
  await bayo
    .locator("#people-list label")
    .filter({ hasText: "ada" + suffix })
    .locator("input")
    .check();
  await bayo.locator("#new-chat-form button").click();
  await chat(bayo, "Private revision plan");
  await expect(bayo.locator("#chat-title")).toHaveText("Maths partners");
  await ada.locator("[data-page=quiz]").click();
  await ada.locator('[name=q0][value="1"]').check();
  await ada.locator('[name=q1][value="2"]').check();
  await ada.locator('[name=q2][value="1"]').check();
  await ada.locator("#quiz-form button").click();
  await expect(ada.locator("#quiz-result")).toContainText("3 out of 3");
  await ada.locator("[data-page=leaderboard]").click();
  await expect(ada.locator("#leaders")).toContainText("3 / 3");
  expect(errors).toEqual([]);
  await a.close();
  await b.close();
});
test("mobile layout stays within viewport", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await signup(page, "mobile" + Date.now().toString().slice(-8));
  await expect(page.locator(".room-banner")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/studylight-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/studylight-desktop.png",
    fullPage: true,
  });
  await ctx.close();
});
test("images are compressed before upload and short voice notes play from saved storage", async ({
  page,
}) => {
  await signup(page, "media" + Date.now().toString().slice(-8));
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1800;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#285c47";
    context.fillRect(0, 0, 1800, 1200);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "lesson.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  await expect(page.locator("#attachment-preview")).toContainText(
    "lesson.webp",
  );
  await page.locator(".send-button").click();
  const image = page
    .locator("#messages button")
    .filter({ hasText: "lesson.webp" });
  await expect(image).toBeVisible();
  await image.click();
  await expect(page.locator("#messages img")).toBeVisible();
  await page.locator("#record-button").click();
  await expect(page.locator("#composer-status")).toContainText("Recording");
  await page.waitForTimeout(1000);
  await page.locator("#record-button").click();
  await expect(page.locator("#attachment-preview")).toContainText("Voice note");
  await page.locator(".send-button").click();
  const voice = page
    .locator("#messages button")
    .filter({ hasText: "Voice note" });
  await expect(voice).toBeVisible();
  await voice.click();
  await expect(page.locator("#messages audio")).toBeVisible();
  await expect
    .poll(() => page.locator("#messages audio").evaluate((a) => a.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.locator("[data-page=resources]").click();
  await expect(page.locator("#resource-list .tile")).toHaveCount(2);
});
