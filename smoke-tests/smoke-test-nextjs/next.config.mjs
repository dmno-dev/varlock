import { varlockNextConfigPlugin } from '@varlock/nextjs-integration/plugin';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
};

export default varlockNextConfigPlugin()(nextConfig);
