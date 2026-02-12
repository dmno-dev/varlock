import { varlockNextjsIntegration } from '@varlock/nextjs-integration';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
};

export default varlockNextjsIntegration()(nextConfig);
