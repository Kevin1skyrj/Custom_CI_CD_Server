const nodeBinary = "/home/ubuntu/.nvm/versions/node/v22.23.2/bin/node";

module.exports = {
  apps: [
    {
      name: "datadock-server",
      cwd: "/var/www/datadock-deploy/current/server",
      script: nodeBinary,
      args: "--env-file=.env server.js",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      restart_delay: 3000,
    },
    {
      name: "datadock-client",
      cwd: "/var/www/datadock-deploy/current/client",
      script: nodeBinary,
      args: "node_modules/next/dist/bin/next start",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
