// custom changelog generator based on @changesets/changelog-github
// only shows "Thanks @username!" for external contributors
// NOTE: must be .cjs because changesets CLI loads this via Node's require()

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getInfo, getInfoFromPullRequest } = require('@changesets/get-github-info');

// core team members - no "Thanks" for these users
const TEAM_MEMBERS = new Set([
  'theoephraim',
  'philmillman',
  'copilot-swe-agent',
]);

function isTeamMember(login) {
  return TEAM_MEMBERS.has(login.toLowerCase());
}

function readEnv() {
  return {
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL || 'https://github.com',
  };
}

/** @type {import('@changesets/types').ChangelogFunctions} */
const changelogFunctions = {
  getDependencyReleaseLine: async (changesets, dependenciesUpdated, options) => {
    if (!options.repo) {
      throw new Error(
        'Please provide a repo to this changelog generator like this:\n"changelog": ["@varlock/changeset-changelog", { "repo": "org/repo" }]',
      );
    }
    if (dependenciesUpdated.length === 0) return '';

    const changesetLink = `- Updated dependencies [${(
      await Promise.all(
        changesets.map(async (cs) => {
          if (cs.commit) {
            const { links } = await getInfo({
              repo: options.repo,
              commit: cs.commit,
            });
            return links.commit;
          }
        }),
      )
    )
      .filter((_) => _)
      .join(', ')}]:`;

    const updatedDependenciesList = dependenciesUpdated.map(
      (dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
    );

    return [changesetLink, ...updatedDependenciesList].join('\n');
  },

  getReleaseLine: async (changeset, _type, options) => {
    const { GITHUB_SERVER_URL } = readEnv();
    if (!options || !options.repo) {
      throw new Error(
        'Please provide a repo to this changelog generator like this:\n"changelog": ["@varlock/changeset-changelog", { "repo": "org/repo" }]',
      );
    }

    let prFromSummary;
    let commitFromSummary;
    const usersFromSummary = [];

    const replacedChangelog = changeset.summary
      .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, (_, pr) => {
        const num = Number(pr);
        if (!Number.isNaN(num)) prFromSummary = num;
        return '';
      })
      .replace(/^\s*commit:\s*([^\s]+)/im, (_, commit) => {
        commitFromSummary = commit;
        return '';
      })
      .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, (_, user) => {
        usersFromSummary.push(user);
        return '';
      })
      .trim();

    const [firstLine, ...futureLines] = replacedChangelog
      .split('\n')
      .map((l) => l.trimEnd());

    const links = await (async () => {
      if (prFromSummary !== undefined) {
        let prLinks = await getInfoFromPullRequest({
          repo: options.repo,
          pull: prFromSummary,
        }).then((r) => r.links);
        if (commitFromSummary) {
          const shortCommitId = commitFromSummary.slice(0, 7);
          prLinks = {
            ...prLinks,
            commit: `[\`${shortCommitId}\`](${GITHUB_SERVER_URL}/${options.repo}/commit/${commitFromSummary})`,
          };
        }
        return prLinks;
      }
      const commitToFetchFrom = commitFromSummary || changeset.commit;
      if (commitToFetchFrom) {
        const commitInfo = await getInfo({
          repo: options.repo,
          commit: commitToFetchFrom,
        });
        return commitInfo.links;
      }
      return {
        commit: null,
        pull: null,
        user: null,
      };
    })();

    // resolve users from summary or from git/PR info
    const users = usersFromSummary.length
      ? usersFromSummary
        .map((u) => `[@${u}](${GITHUB_SERVER_URL}/${u})`)
        .join(', ')
      : links.user;

    // extract raw username(s) to check team membership
    const rawUsernames = usersFromSummary.length
      ? usersFromSummary
      : (links.user?.match(/@([^[\]()]+)\]/g) || []).map((m) => m.slice(1, -1));

    // only thank external contributors
    const allTeamMembers = rawUsernames.length > 0
      && rawUsernames.every((u) => isTeamMember(u));
    const thanksText = users && !allTeamMembers ? ` Thanks ${users}!` : '';

    const prefix = [
      links.pull === null ? '' : ` ${links.pull}`,
      links.commit === null ? '' : ` ${links.commit}`,
      thanksText,
    ].join('');

    return `\n\n-${prefix ? `${prefix} -` : ''} ${firstLine}\n${futureLines
      .map((l) => `  ${l}`)
      .join('\n')}`;
  },
};

module.exports = changelogFunctions;
