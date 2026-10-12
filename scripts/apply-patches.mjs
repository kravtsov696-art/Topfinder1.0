// Временные исправления зависимостей (до выхода исправленных версий в npm).
// expo-modules-jsi 57.1.1 не собирается на Xcode 26 (Swift 6.2) — берём исправление из ветки
// expo/expo sdk-57 (коммит bd2ade7, PR #51040). Применяется только к точной версии и только один раз.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const gh = process.env.GITHUB_ACTIONS === 'true';
const note = (m) => console.log(gh ? `::notice::${m}` : m);
const patches = [{ pkg: 'expo-modules-jsi', version: '57.1.1', file: 'patches/expo-modules-jsi+57.1.1+xcode26.patch' }];
for (const p of patches) {
  const dir = join('node_modules', p.pkg);
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) continue;
  const v = JSON.parse(readFileSync(pj, 'utf8')).version;
  if (v !== p.version) {
    note(`[patches] ${p.pkg}@${v}: патч для ${p.version} пропущен`);
    continue;
  }
  const args = ['-p3', '-d', dir, '-i', resolve(p.file), '--forward', '--batch'];
  try {
    execFileSync('patch', [...args, '--dry-run'], { stdio: 'pipe' });
  } catch (e) {
    // Уже применён? Проверяем обратным применением
    try {
      execFileSync('patch', ['-p3', '-d', dir, '-i', resolve(p.file), '--reverse', '--dry-run', '--batch'], { stdio: 'pipe' });
      note(`[patches] ${p.pkg}: уже применён`);
      continue;
    } catch {
      const out = String(e.stdout ?? '') + String(e.stderr ?? '');
      console.log(gh ? `::error::[patches] ${p.pkg}: патч не подходит: ${out.replace(/\n/g, ' | ').slice(0, 800)}` : out);
      process.exit(1);
    }
  }
  execFileSync('patch', args, { stdio: 'inherit' });
  note(`[patches] ${p.pkg}@${v}: применён ${p.file}`);
}
