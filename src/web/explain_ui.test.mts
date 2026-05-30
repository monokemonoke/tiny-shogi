import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

async function readExplainHtml(): Promise<string> {
    return await readFile(resolve(currentDir, 'explain.html'), 'utf8');
}

test('解説画面は左右パネルと下部タイムラインの枠を持つ', async () => {
    const html = await readExplainHtml();

    for (const id of [
        'explain-shell',
        'analysis-card',
        'issue-summary',
        'score-gap',
        'feature-list',
        'timeline-bar',
        'previous-move',
        'next-move'
    ]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
});

test('解説UIは半透明カードと評価差表示のスタイルを持つ', async () => {
    const html = await readExplainHtml();

    assert.match(html, /\.glass-panel/);
    assert.match(html, /backdrop-filter:\s*blur/);
    assert.match(html, /\.score-shift/);
});
