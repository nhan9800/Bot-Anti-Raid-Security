module.exports = {
  apps: [
    {
      name: "bot-anti-raid-security",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
