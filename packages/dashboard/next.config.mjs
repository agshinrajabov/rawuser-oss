/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  // Type-only imports from @rawuser/shared are fine — shared is a TS source package
  transpilePackages: ["@rawuser/shared"],
};

export default nextConfig;
