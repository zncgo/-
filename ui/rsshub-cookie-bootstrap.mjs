import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const cookieMappings = [
    { file: '/cookies/xiaohongshu.json', environment: 'XIAOHONGSHU_COOKIE', platform: 'xiaohongshu' },
    { file: '/cookies/bilibili.json', environment: 'BILIBILI_COOKIE_0', platform: 'bilibili' },
];

function toCookieHeader(source) {
    const entries = Array.isArray(source) ? source : Array.isArray(source?.cookies) ? source.cookies : [];
    const now = Date.now() / 1000;
    const values = new Map();
    for (const cookie of entries) {
        if (!cookie?.name || typeof cookie.value !== 'string') continue;
        const expires = Number(cookie.expirationDate || cookie.expires || 0);
        if (expires > 0 && expires <= now) continue;
        values.set(cookie.name, cookie.value);
    }
    return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

for (const mapping of cookieMappings) {
    try {
        const source = JSON.parse(await readFile(mapping.file, 'utf8'));
        const header = toCookieHeader(source);
        if (header) {
            process.env[mapping.environment] = header;
            console.log(`[cookie-bootstrap] ${mapping.platform}: loaded`);
        } else {
            console.log(`[cookie-bootstrap] ${mapping.platform}: no usable cookies`);
        }
    } catch (error) {
        if (error?.code === 'ENOENT') {
            console.log(`[cookie-bootstrap] ${mapping.platform}: file not found`);
        } else {
            console.error(`[cookie-bootstrap] ${mapping.platform}: invalid cookie file`);
        }
    }
}

const child = spawn('npm', ['run', 'start'], {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 1));
