import type { NextConfig } from 'next';
import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';

const withVarlock = varlockNextConfigPlugin();

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: true,
  typescript: { ignoreBuildErrors: true },
};

export default withVarlock(nextConfig);
