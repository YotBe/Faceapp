import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Reached by IP as well as by name during local development and in the
  // end-to-end browser run.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  
};

export default nextConfig;
