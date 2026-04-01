/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingExcludes: {
    "*": [
      "**/Cookies/**",
      "**/AppData/Local/**",
      "**/node_modules/.cache/**",
    ],
  },
  outputFileTracingIncludes: {
    // server.js is spawned as a child process so the tracer misses it —
    // explicitly include the entire MITM subtree in the standalone output
    "*": ["./src/mitm/**/*"],
  },
  images: {
    unoptimized: true
  },
  env: {},
  turbopack: {},
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Stop watching logs directory to prevent HMR during streaming
    config.watchOptions = { ...config.watchOptions, ignored: /[\\/](logs|\.next)[\\/]/ };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
