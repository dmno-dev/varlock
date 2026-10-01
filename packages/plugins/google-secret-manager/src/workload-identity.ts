import { getOidcToken } from '@env-spec/utils/oidc-tokens';

export function createSubjectTokenSupplier(
  workloadIdentityProvider: string,
  oidcToken?: string,
) {
  return {
    async getSubjectToken() {
      if (oidcToken) return oidcToken;

      const result = await getOidcToken(workloadIdentityProvider);
      if (!result?.token) {
        throw new Error('Unable to obtain an OIDC token for Google Workload Identity Federation');
      }
      return result.token;
    },
  };
}
