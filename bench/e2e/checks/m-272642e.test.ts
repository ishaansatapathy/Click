import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('login theme switch visibility', () => {
  it('renders the switch only when the settings store enables it', () => {
    const source = readFileSync('src/pages/login/index.vue', 'utf8');
    expect(source).toContain('const settingsStore = useSettingsStore()');
    expect(source).toMatch(/<ThemeSwitch\s+v-if="settingsStore\.showThemeSwitch"\s+class="theme-switch"\s*\/>/);
  });
});
