import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectTaste(page, directory, name) {
  const root = process.env.TASTE_SKILL_ROOT;
  if (!root) return { requested: false, reason: 'Local design-skill inspection is separate from hosted browser conformance.' };
  const probes = await import(pathToFileURL(join(root, 'scripts/lib/probe.mjs')).href);
  const rules = await import(pathToFileURL(join(root, 'scripts/lib/rules.mjs')).href);
  await page.evaluate(async () => {
    scrollTo(0, 0);
    await document.fonts.ready;
    await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
  });
  const metrics = await page.evaluate(probes.probe);
  const layout = await page.evaluate(probes.layout);
  const app = await page.evaluate(probes.app);
  const width = page.viewportSize().width;
  let findings = [...rules.judge(metrics, { width }), ...rules.judgeLayout(layout, { width })]
    .filter(value => !rules.APP_SKIP.has(value.id) && value.id !== 'no-title' && value.id !== 'small-title');
  findings.push(...rules.judgeApp(app, metrics, { width }));
  findings = findings.filter(value => !rules.APP_SKIP.has(value.id));
  if (!await page.evaluate(() => document.fonts.check('14px Geist'))) findings.push({ level: 'FAIL', id: 'font-not-dealt', message: 'The dealt Geist face did not load.' });
  const frames = [];
  const modal = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('dialog:modal')].at(-1);
    if (!dialog) return null;
    const clipped = [], covered = [];
    const drawer = dialog.classList.contains('worker-drawer');
    const heading = dialog.querySelector('.drawer-heading');
    const initialTop = dialog.scrollTop;
    const items = [dialog, ...dialog.querySelectorAll('h2, p, code, button')];
    for (const element of items) {
      if (!element.checkVisibility()) continue;
      if (drawer && element !== dialog && !heading.contains(element)) element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const text = element === dialog ? 'Active dialog' : element.textContent.trim().slice(0, 48);
      if (box.left < -1 || box.right > innerWidth + 1 || (!drawer && (box.top < -1 || box.bottom > innerHeight + 1))) clipped.push({ text });
      const center = box.top + box.height / 2;
      if (drawer && (center < 0 || center >= innerHeight)) continue;
      const hit = document.elementFromPoint(box.left + box.width / 2, center);
      if (hit && !element.contains(hit) && !hit.contains(element)) covered.push({ text });
    }
    dialog.scrollTop = initialTop;
    return { clipped, covered, focus_inside: dialog.contains(document.activeElement) };
  });
  if (modal) {
    frames.push(modal);
    if (!modal.focus_inside) findings.push({ level: 'FAIL', id: 'dialog-focus', message: 'Keyboard focus escaped the active native dialog.' });
  } else {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += page.viewportSize().height) {
      await page.evaluate(position => scrollTo(0, position), y);
      frames.push(await page.evaluate(probes.frame));
    }
  }
  if (frames.some(value => value.covered.length || value.clipped.length)) findings.push({ level: 'FAIL', id: 'covered-text', message: 'Text is covered or clipped while scrolling.' });
  await page.evaluate(() => scrollTo(0, 0));
  const report = { requested: true, style: 'achromatic-ledger', seed: 15, width, name, scope: modal ? 'active native modal; inactive backdrop excluded from hit-testing' : 'page', findings, metrics, layout, app, frames };
  writeFileSync(join(directory, `taste-${name}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  if (findings.some(value => value.level === 'FAIL')) throw new Error(`Design inspector failed for ${name}; inspect its private taste report.`);
  return { requested: true, report: `taste-${name}.json`, warnings: findings.filter(value => value.level === 'WARN').map(value => ({ id: value.id, message: value.message })) };
}
