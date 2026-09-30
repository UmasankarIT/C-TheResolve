/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents double-mounting map containers in dev
  output: 'standalone', // Slim self-contained server for the Docker/Cloud Run image
  experimental: {
    // Enables instrumentation.ts (stable in Next 15): boots the Firebase
    // demo-account provisioning pass when the server starts, instead of
    // waiting for the first login attempt.
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
};

module.exports = nextConfig;
