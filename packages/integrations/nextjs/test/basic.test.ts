import {
  beforeAll, describe, expect, it,
} from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import outdent from 'outdent';
import { asyncExec } from '@env-spec/utils/exec-helpers';


const tempRepoDir = path.join(__dirname, 'test-project');

async function cliCommand(cmd: string, opts?: {
  env?: Record<string, string>,
  throw?: boolean,
}) {
  try {
    const result = await asyncExec(cmd, {
      // stdio: 'inherit',
      cwd: tempRepoDir,
      ...opts?.env && {
        env: {
          ...process.env,
          ...opts.env,
        },
      },
    });
    return {
      error: false,
      stdout: result.stdout,
    };
  } catch (err) {
    if (opts?.throw) throw err;
    const error = err as any;
    return {
      error: true,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}
function addFile(filePath: string, content: string) {
  const dirPath = path.dirname(path.join(tempRepoDir, filePath));
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(tempRepoDir, filePath), content);
}

async function setupNextProject(opts?: {
  nextVersion?: string,
  noConfigPlugin?: boolean,
  nextConfigOptions?: any,
}) {
  execSync(`mkdir -p ${tempRepoDir}`);
  // need pnpm-workspace.yaml so it will not be included in root workspace
  addFile('pnpm-workspace.yaml', '');
  addFile('package.json', JSON.stringify({
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      '@varlock/nextjs-integration': 'link:../../',
      next: `${opts?.nextVersion || 'latest'}`,
      varlock: 'link:../../../../varlock',
    },
    devDependencies: {
      '@types/react': '19.1.8',
    },
    pnpm: {
      overrides: {
        '@next/env': '$@varlock/nextjs-integration',
      },
    },
  }, null, 2));
  await cliCommand('pnpm install', { throw: true });
  // add next config file
  addFile('next.config.ts', outdent`
    import type { NextConfig } from "next";
    ${opts?.noConfigPlugin ? '' : 'import { varlockNextConfigPlugin } from "@varlock/nextjs-integration/plugin";'}

    console.log('log-in-next-config--'+process.env.SECRET_FOO);

    const nextConfig: NextConfig = ${JSON.stringify({
      eslint: { ignoreDuringBuilds: true },
      ...opts?.nextConfigOptions,
    }, null, 2)};
    export default ${opts?.noConfigPlugin ? 'nextConfig' : 'varlockNextConfigPlugin()(nextConfig)'};
  `);
  addFile('tsconfig.json', outdent`
    {
      "compilerOptions": {
        "target": "ES2017",
        "lib": ["dom", "dom.iterable", "esnext"],
        "allowJs": true,
        "skipLibCheck": true,
        "strict": true,
        "noEmit": true,
        "esModuleInterop": true,
        "module": "esnext",
        "moduleResolution": "bundler",
        "resolveJsonModule": true,
        "isolatedModules": true,
        "jsx": "preserve",
        "incremental": true,
        "plugins": [{ "name": "next" }],
        "paths": { "@/*": ["./*"] }
      },
      "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      "exclude": ["node_modules"]
    }
  `);

  addFile('.env.schema', outdent`
    # @envFlag=APP_ENV
    # @defaultSensitive=false
    # @generateTypes(lang='ts', path='env.d.ts')
    # ---
    APP_ENV=development
    NEXT_PUBLIC_FOO=next-public-foo
    PUBLIC_FOO=public-foo
    # @sensitive
    SECRET_FOO=secret-foo
    ENV_SPECIFIC_OVERRIDE=default
  `);
  // addFile('.env.test', 'ENV_SPECIFIC_OVERRIDE=test-val');
  // addFile('.env.production', 'ENV_SPECIFIC_OVERRIDE=prod-val');
  // addFile('.env.development', 'ENV_SPECIFIC_OVERRIDE=dev-val');
  addFile('.env.preview', 'ENV_SPECIFIC_OVERRIDE=preview-val');
  addFile('app/layout.tsx', outdent`
    export default function RootLayout({ children }: { children: React.ReactNode }) {
      return (<html lang="en"><body>{children}</body></html>);
    }
  `);
}

function runNextTest(testCase: {
  buildCommand?: string,
  pageContent: string,
  buildOutputContains?: string,
  buildOutputNotContains?: string,
  buildErrorMessageContains?: string,
  pageContains?: string | Array<string>,
  pageNotContain?: string | Array<string>,
}) {
  return async () => {
    addFile('app/page.tsx', testCase.pageContent);
    const buildResult = await cliCommand(
      testCase.buildCommand || 'pnpm build',
      { env: { APP_ENV: 'preview' } },
    );
    if (testCase.buildOutputContains) {
      expect(buildResult.stdout).toContain(testCase.buildOutputContains);
    }
    if (testCase.buildOutputNotContains) {
      expect(buildResult.stdout).not.toContain(testCase.buildOutputNotContains);
    }

    if (testCase.buildErrorMessageContains) {
      expect(buildResult.error, 'build should fail').toBe(true);
      console.log('------');
      expect(buildResult.stderr).toContain(testCase.buildErrorMessageContains);
      return;
    }
    if (testCase.pageContains) {
      const prerenderedHtmlPath = path.join(tempRepoDir, '.next', 'server', 'app', 'index.html');
      const pageContent = fs.readFileSync(prerenderedHtmlPath, 'utf-8')
        .replaceAll('<!-- -->', '');

      if (testCase.pageContains) {
        const containsItems = Array.isArray(testCase.pageContains) ? testCase.pageContains : [testCase.pageContains];
        for (const containsItem of containsItems) {
          expect(pageContent).toContain(containsItem);
        }
      }

      if (testCase.pageNotContain) {
        const notContainsItems = Array.isArray(testCase.pageNotContain)
          ? testCase.pageNotContain : [testCase.pageNotContain];
        for (const notContainsItem of notContainsItems) {
          expect(pageContent).not.toContain(notContainsItem);
        }
      }
    }
  };
}


describe('no next.config.ts plugin', () => {
  beforeAll(async () => {
    await setupNextProject({
      noConfigPlugin: true,
    });
  });

  it('can load and access env vars', runNextTest({
    pageContent: outdent`
      export default function Page() {
        return <p>
          - penv--{ process.env.NEXT_PUBLIC_FOO }
          - penv--{ process.env.PUBLIC_FOO }
          - penv--{ process.env.SECRET_FOO }
          - penv--{ process.env.ENV_SPECIFIC_OVERRIDE }
        </p>;
      }
    `,
    // logs are redacted, even without the plugin
    buildOutputContains: 'log-in-next-config--se▒',
    buildOutputNotContains: 'log-in-next-config--secret-foo',
    pageContains: [
      'penv--next-public-foo',
      'penv--public-foo', // page is server rendered, so it appears even though it is not available in client
      'penv--secret-foo', // leak detection is not enabled, so it will be in the page
      'penv--preview-val', // .env.preview should be loaded
    ],
  }));

  // TODO: check it works with --turborepo - but will need to run next dev instead
});




describe('full integration', () => {
  beforeAll(async () => {
    await setupNextProject({});
  });

  it('can load and access env vars', runNextTest({
    pageContent: outdent`
      import { ENV } from 'varlock/env';
      export default function Page() {
        return <p>
          venv--{ ENV.NEXT_PUBLIC_FOO }
          penv--{ process.env.NEXT_PUBLIC_FOO }
          venv--{ ENV.PUBLIC_FOO }
          penv--{ process.env.PUBLIC_FOO }
        </p>;
      }
    `,
    pageContains: [
      'venv--next-public-foo',
      'penv--next-public-foo',
      'venv--public-foo',
      'penv--public-foo',
    ],
  }));
  it('fails the build if a secret is leaked in a static template', runNextTest({
    pageContent: outdent`
      import { ENV } from 'varlock/env';
      export default function Page() {
        return <p>{ ENV.SECRET_FOO }</p>;
      }
    `,
    buildErrorMessageContains: 'LEAK',
  }));

  it('fails the build if a secret is leaked in a use client page', runNextTest({
    pageContent: outdent`
      'use client';
      import { ENV } from 'varlock/env';
      export default function Page() {
        return <p>{ ENV.SECRET_FOO }</p>;
      }
    `,
    buildErrorMessageContains: 'LEAK',
  }));
});


