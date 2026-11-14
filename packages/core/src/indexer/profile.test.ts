import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { profileRepo } from './profile.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('profileRepo', () => {
  it('profiles JSONC paths, AST aliases, app structure, tests, and auto-import maps', async () => {
    const root = await fixtureRepo();
    const profile = profileRepo(root);

    expect(profile.root).toBe(root);
    expect(profile.baseUrl).toBe('src');
    expect(profile.tsconfigPaths).toEqual({ '@/*': ['src/*'] });
    expect(profile.viteAliases).toEqual({ '@': 'src', '@components': 'src/components' });
    expect(profile.entryFile).toBe('src/main.ts');
    expect(profile.routerFiles).toEqual(['src/router/index.ts']);
    expect(profile.storeFiles).toEqual(['src/stores/user.ts']);
    expect(profile.testGlobs).toEqual(['src/**/*.spec.ts']);
    expect(profile.autoImport).toEqual({
      components: { UserCard: 'src/components/UserCard.vue' },
      imports: { ref: 'vue' },
    });
    expect(profile.counts).toMatchObject({ '.ts': 7, '.vue': 2 });
  });

  it('chooses a product entry over playground entry files', async () => {
    const root = await fixtureRepo();
    await write(root, 'playground/src/main.ts', "import { createApp } from 'vue'; createApp({}).mount('#app')\n");
    expect(profileRepo(root).entryFile).toBe('src/main.ts');
  });

  it('resolves import.meta.url aliases relative to the Vite config', async () => {
    const root = await fixtureRepo();
    await write(root, 'nested/vite.config.ts', `
      import { dirname, resolve } from 'node:path'
      import { fileURLToPath } from 'node:url'
      const root = dirname(fileURLToPath(import.meta.url))
      export default { resolve: { alias: { '~': resolve(root, 'source'), vue: '@vue/runtime-dom' } } }
    `);
    expect(profileRepo(root).viteAliases).toMatchObject({ '~': 'nested/source', vue: '@vue/runtime-dom' });
  });
});

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'click-profile-'));
  temporaryPaths.push(root);
  await write(root, 'tsconfig.json', `{
    // JSONC is intentional
    "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } }
  }`);
  await write(root, 'vite.config.ts', `
    import { resolve } from 'node:path'
    import { defineConfig } from 'vite'
    const root = __dirname
    export default defineConfig({
      resolve: { alias: { '@': resolve(root, 'src'), '@components': resolve(root, 'src/components') } },
      test: { include: ['src/**/*.spec.ts'] }
    })
  `);
  await write(root, 'src/main.ts', "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app')\n");
  await write(root, 'src/App.vue', '<template><UserCard /></template>\n');
  await write(root, 'src/router/index.ts', "import { createRouter } from 'vue-router'; export const router = createRouter({} as never)\n");
  await write(root, 'src/stores/user.ts', "import { defineStore } from 'pinia'; export const useUserStore = defineStore('user', {})\n");
  await write(root, 'src/components/UserCard.vue', '<template>User</template>\n');
  await write(root, 'src/user.spec.ts', "import { describe } from 'vitest'; void describe\n");
  await write(root, 'components.d.ts', `declare module 'vue' { interface GlobalComponents {
    UserCard: typeof import('./src/components/UserCard.vue')['default']
  } }`);
  await write(root, 'auto-imports.d.ts', `declare global {
    const ref: typeof import('vue')['ref']
  }`);
  return root;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}
