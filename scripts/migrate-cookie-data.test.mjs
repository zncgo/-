import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./migrate-cookie-data.ps1', import.meta.url));

function runMigration(args) {
    return spawnSync('pwsh', ['-NoProfile', '-File', script, ...args], { encoding: 'utf8' });
}

test('migration copies fixture Cookie data through a temporary directory without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsshub-migration-target-'));
    const source = await mkdtemp(join(tmpdir(), 'rsshub-migration-source-'));
    const sourceCookie = join(source, 'douyin.json');
    const fixture = '[{"domain":".douyin.com","name":"fixture","value":"test-only"}]';
    try {
        await writeFile(sourceCookie, fixture, 'utf8');
        await mkdir(join(source, '.state'));
        await writeFile(join(source, '.state', 'cookie-pool.json'), '{"version":1}', 'utf8');
        const result = runMigration(['-UserDataRoot', root, '-SourceDirectory', source]);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(await readFile(sourceCookie, 'utf8'), fixture);
        assert.equal(await readFile(join(root, 'cookies', 'douyin.json'), 'utf8'), fixture);
        const marker = JSON.parse(await readFile(join(root, '.cookie-migration.json'), 'utf8'));
        assert.equal(marker.fileCount, 2);
        assert.equal(marker.jsonValidated, true);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
    }
});

test('migration refuses a non-empty target before it accesses a source volume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsshub-migration-nonempty-'));
    try {
        await mkdir(join(root, 'cookies'));
        await writeFile(join(root, 'cookies', 'keep.txt'), 'keep', 'utf8');
        const result = runMigration(['-UserDataRoot', root, '-SourceVolume', 'does-not-exist']);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /目标目录非空/);
        assert.equal(await readFile(join(root, 'cookies', 'keep.txt'), 'utf8'), 'keep');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
