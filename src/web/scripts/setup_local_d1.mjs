import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDbPath = path.join(projectRoot, '../solver/data/lookup.db');
const d1StateDir = path.join(projectRoot, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');

async function main() {
    if (!fs.existsSync(dataDbPath)) {
        console.error(`Error: ${dataDbPath} not found.`);
        process.exit(1);
    }

    console.log('Cleaning .wrangler d1 state...');
    if (fs.existsSync(d1StateDir)) {
        fs.rmSync(d1StateDir, { recursive: true, force: true });
    }

    // Ensure wrangler.toml exists
    if (!fs.existsSync(path.join(projectRoot, 'wrangler.toml'))) {
        console.log('Copying wrangler.public.toml to wrangler.toml...');
        fs.copyFileSync(path.join(projectRoot, 'wrangler.public.toml'), path.join(projectRoot, 'wrangler.toml'));
    }

    console.log('Initializing D1 via Wrangler...');
    // Force initialization by running a dummy query locally
    const initCmd = 'npx';
    const initArgs = ['wrangler', 'd1', 'execute', 'minishogi-lookup', '--local', '--command', 'SELECT 1'];

    const child = spawn(initCmd, initArgs, {
        cwd: projectRoot,
        stdio: 'inherit' // Show output to user
    });

    await new Promise((resolve) => {
        child.on('close', resolve);
    });

    console.log('Waiting for DB file creation...');

    // Poll for file existence
    let targetFile;
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(d1StateDir)) {
            const files = fs.readdirSync(d1StateDir).filter(f => f.endsWith('.sqlite'));
            if (files.length > 0) {
                targetFile = files[0];
                break;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!targetFile) {
        console.error('Error: .sqlite file was not created.');
        process.exit(1);
    }

    const targetPath = path.join(d1StateDir, targetFile);

    console.log(`Found target DB: ${targetFile}`);

    // Remove generated empty file
    fs.unlinkSync(targetPath);

    // Create symlink
    // Create link
    try {
        // Try hard link first (bypasses symlink restrictions)
        fs.linkSync(dataDbPath, targetPath);
        console.log(`Successfully hard-linked ${dataDbPath} to ${targetPath}`);
    } catch (e) {
        console.log('Hard link failed, trying symlink:', e.message);
        try {
            fs.symlinkSync(dataDbPath, targetPath);
            console.log(`Successfully linked ${dataDbPath} to ${targetPath}`);
        } catch (e2) {
            console.error('Failed to link:', e2);
            console.log('Copying file instead (this may take a while)...');
            fs.copyFileSync(dataDbPath, targetPath);
            console.log(`Successfully copied ${dataDbPath} to ${targetPath}`);
        }
    }

    // Clean wal/shm
    const wal = targetPath + '-wal';
    const shm = targetPath + '-shm';
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);

    console.log('Setup finished. You can now run "npm run pages:dev".');
}

main();
