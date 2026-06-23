import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

vi.mock('../js-package-manager-utils', () => ({
  detectJsPackageManager: vi.fn(),
}));

import { detectJsPackageManager } from '../js-package-manager-utils';
import { getJsPackageManagerForTelemetry, normalizeGitRemoteUrl, getProjectSlugFromCi } from '../telemetry';

describe('getJsPackageManagerForTelemetry', () => {
  beforeEach(() => {
    vi.mocked(detectJsPackageManager).mockReset();
  });

  it('returns the detected package manager name', () => {
    vi.mocked(detectJsPackageManager).mockReturnValue({
      name: 'pnpm',
      lockfiles: ['pnpm-lock.yaml'],
      add: 'pnpm add',
      exec: 'pnpm exec',
      dlx: 'pnpm dlx',
    });

    expect(getJsPackageManagerForTelemetry()).toBe('pnpm');
  });

  it('returns null when no package manager is detected', () => {
    vi.mocked(detectJsPackageManager).mockReturnValue(undefined);
    expect(getJsPackageManagerForTelemetry()).toBeNull();
  });
});

describe('normalizeGitRemoteUrl', () => {
  it('collapses http/ssh/scp/git clone variants to the same canonical value', () => {
    const variants = [
      'git@github.com:owner/repo.git',
      'git@github.com:owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git',
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo',
      'http://github.com/owner/repo.git',
      'https://user:token@github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      'https://github.com/owner/repo/',
      'https://GitHub.com/Owner/Repo.git',
    ];
    for (const v of variants) {
      expect(normalizeGitRemoteUrl(v), v).toBe('github.com/owner/repo');
    }
  });

  it('keeps host distinct so same owner/repo on different hosts do not collide', () => {
    expect(normalizeGitRemoteUrl('git@gitlab.com:owner/repo.git')).toBe('gitlab.com/owner/repo');
    expect(normalizeGitRemoteUrl('https://bitbucket.org/owner/repo.git')).toBe('bitbucket.org/owner/repo');
  });

  it('preserves nested groups (e.g. gitlab subgroups)', () => {
    expect(normalizeGitRemoteUrl('git@gitlab.com:group/subgroup/repo.git'))
      .toBe('gitlab.com/group/subgroup/repo');
    expect(normalizeGitRemoteUrl('https://gitlab.com/group/subgroup/repo.git'))
      .toBe('gitlab.com/group/subgroup/repo');
  });

  it('returns undefined for unparseable or empty input', () => {
    expect(normalizeGitRemoteUrl('')).toBeUndefined();
    expect(normalizeGitRemoteUrl('   ')).toBeUndefined();
    expect(normalizeGitRemoteUrl('not-a-url')).toBeUndefined();
    expect(normalizeGitRemoteUrl('https://github.com')).toBeUndefined();
  });
});

describe('getProjectSlugFromCi', () => {
  it('resolves GitHub Actions repo slug', () => {
    expect(getProjectSlugFromCi({ GITHUB_REPOSITORY: 'Owner/Repo' })).toBe('github.com/owner/repo');
  });

  it('honors GITHUB_SERVER_URL for GitHub Enterprise', () => {
    expect(getProjectSlugFromCi({
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: 'https://github.acme.com',
    })).toBe('github.acme.com/owner/repo');
  });

  it('resolves GitLab CI slug incl. subgroups', () => {
    expect(getProjectSlugFromCi({
      CI_SERVER_HOST: 'gitlab.com',
      CI_PROJECT_PATH: 'group/subgroup/repo',
    })).toBe('gitlab.com/group/subgroup/repo');
  });

  it('resolves Bitbucket Pipelines slug', () => {
    expect(getProjectSlugFromCi({ BITBUCKET_REPO_FULL_NAME: 'workspace/repo' }))
      .toBe('bitbucket.org/workspace/repo');
  });

  it('matches normalizeGitRemoteUrl output for the same repo (CI vs local clone)', () => {
    expect(getProjectSlugFromCi({ GITHUB_REPOSITORY: 'owner/repo' }))
      .toBe(normalizeGitRemoteUrl('git@github.com:owner/repo.git'));
  });

  it('returns undefined when no CI repo vars are present', () => {
    expect(getProjectSlugFromCi({})).toBeUndefined();
  });
});
