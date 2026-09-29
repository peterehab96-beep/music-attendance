import { readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const functionsDir = 'functions';
const files = await readdir(functionsDir);

for (const file of files) {
  if (!file.endsWith('.ts') || file.startsWith('_')) continue;
  const slug = file.replace('.ts', '');
  console.log(`Deploying function: ${slug}...`);
  try {
    execSync(`npx @insforge/cli functions deploy ${slug} --file functions/${file}`, { stdio: 'inherit' });
    console.log(`Successfully deployed ${slug}`);
  } catch (err) {
    console.error(`Failed to deploy ${slug}`);
  }
}
