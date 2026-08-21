import varlockPkg from '../../../varlock/package.json' with { type: 'json' };

export const SITE_URL = 'https://varlock.dev';
export const GITHUB_URL = 'https://github.com/dmno-dev/varlock';
export const NPM_URL = 'https://www.npmjs.com/package/varlock';
export const DISCORD_URL = 'https://chat.dmno.dev';
export const ORG_URL = 'https://dmno.io';
export const CONTACT_EMAIL = 'hello@varlock.dev';
export const SECURITY_EMAIL = 'security@varlock.dev';

const ORG_ID = `${ORG_URL}/#organization`;
const SOFTWARE_ID = `${SITE_URL}/#software`;

/**
 * Site-wide schema.org JSON-LD graph: the publisher (DMNO Inc.), the product (Varlock), and the website.
 * Emitted on every page from CustomHead.astro. No postal address on purpose: varlock is an open source
 * project and we do not publish a street address.
 */
export function buildJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': ORG_ID,
        name: 'DMNO Inc.',
        url: ORG_URL,
        logo: `${SITE_URL}/favicon.png`,
        sameAs: ['https://github.com/dmno-dev', DISCORD_URL],
        contactPoint: [
          {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            email: CONTACT_EMAIL,
            url: `${SITE_URL}/contact/`,
            availableLanguage: 'English',
          },
          {
            '@type': 'ContactPoint',
            contactType: 'security',
            email: SECURITY_EMAIL,
            url: `${GITHUB_URL}/security/policy`,
            availableLanguage: 'English',
          },
        ],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': SOFTWARE_ID,
        name: 'Varlock',
        description:
          'Open source CLI and library for AI-safe .env files. A .env.schema declares and validates environment variables, '
          + 'secrets are encrypted or loaded from external providers, and redaction plus a credential proxy keep secret values '
          + 'away from logs, terminals, and AI agents.',
        url: SITE_URL,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Environment variable and secrets management',
        operatingSystem: 'macOS, Linux, Windows',
        softwareVersion: varlockPkg.version,
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        downloadUrl: NPM_URL,
        installUrl: `${SITE_URL}/getting-started/installation/`,
        softwareHelp: { '@type': 'CreativeWork', url: `${SITE_URL}/getting-started/introduction/` },
        codeRepository: GITHUB_URL,
        sameAs: [GITHUB_URL, NPM_URL],
        author: { '@id': ORG_ID },
        publisher: { '@id': ORG_ID },
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'Varlock',
        url: SITE_URL,
        publisher: { '@id': ORG_ID },
        about: { '@id': SOFTWARE_ID },
      },
    ],
  };
}

/** Serialized for a `<script type="application/ld+json">` tag (escapes `<` so it cannot close the tag). */
export function jsonLdScriptContent() {
  return JSON.stringify(buildJsonLd()).replace(/</g, '\\u003c');
}
