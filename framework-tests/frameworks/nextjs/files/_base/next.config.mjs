import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OUTPUT-MODE
  productionBrowserSourceMaps: true,
  eslint: { ignoreDuringBuilds: true },
};

export default varlockNextConfigPlugin()(nextConfig);
