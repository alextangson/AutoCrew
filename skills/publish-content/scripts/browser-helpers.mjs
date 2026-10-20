/* global document: readonly -- page.evaluate callbacks execute in the browser. */
// Called only from ego-browser nodejs with a documented ego Page.
const normalize = s => String(s ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const topicName = s => normalize(s).replace(/^#/, '').replace(/\[话题\]#$/, '').trim();
export async function readEditor(page, config) {
  return page.evaluate(({selector, rootSelector, topicSelector}) => {
    const root = rootSelector ? document.querySelector(rootSelector)?.shadowRoot : document;
    if (!root) throw new Error('Observed shadow root is missing');
    const matches = root.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error('Editor selector must match exactly one node');
    const editor = matches[0];
    const topics = topicSelector ? [...editor.querySelectorAll(topicSelector)].map(n => n.innerText || n.textContent) : [];
    const copy = editor.cloneNode(true);
    if (topicSelector) copy.querySelectorAll(topicSelector).forEach(n => n.remove());
    // Detached innerText is unreliable. Preserve block boundaries without altering the live DOM.
    copy.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    copy.querySelectorAll('p,div').forEach(n => n.append('\n'));
    return {caption: copy.textContent, topics, fullText: editor.innerText};
  }, config);
}
export async function focusEnd(page, config) {
  await page.evaluate(({selector, rootSelector}) => {
    const root = rootSelector ? document.querySelector(rootSelector)?.shadowRoot : document;
    const nodes = root?.querySelectorAll(selector);
    if (!nodes || nodes.length !== 1 || !nodes[0].isContentEditable) throw new Error('Expected one editable node');
    const e = nodes[0]; e.focus();
    const range = e.ownerDocument.createRange(); range.selectNodeContents(e); range.collapse(false);
    const selection = e.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, config);
}
export async function replaceText(page, config, caption) {
  await focusEnd(page, config);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  const empty = await readEditor(page, config);
  if (normalize(empty.fullText)) throw new Error('Clear failed; stopped before inserting duplicate text');
  await page.keyboard.insertText(caption);
  assertReadback(await readEditor(page, config), {caption, tags: []});
}
export function assertReadback(actual, expected) {
  const errors = [];
  if (normalize(actual.caption) !== normalize(expected.caption)) errors.push('caption mismatch');
  const got = (actual.topics || []).map(topicName), want = (expected.tags || []).map(topicName);
  if (got.length !== want.length || new Set(got).size !== got.length || want.some(t => !got.includes(t))) errors.push('native topic mismatch');
  if (errors.length) throw new Error(errors.join('; '));
  return {ok: true};
}
export async function waitTopics(page, config, expectedTags, timeout = 10000) {
  await page.waitForFunction(({config, tags}) => {
    const root = config.rootSelector ? document.querySelector(config.rootSelector)?.shadowRoot : document;
    const nodes = root?.querySelectorAll(config.selector);
    if (!nodes || nodes.length !== 1 || !config.topicSelector) return false;
    const norm = s => String(s).replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim().replace(/^#/,'').replace(/\[话题\]#$/,'').trim();
    const got = [...nodes[0].querySelectorAll(config.topicSelector)].map(n=>norm(n.innerText || n.textContent));
    return tags.every(t => got.includes(norm(t)));
  }, {config, tags: expectedTags}, {timeout});
}
