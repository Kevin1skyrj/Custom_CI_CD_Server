module.exports = {
  apps: [
    {
      name: "datadock-server",
      cwd: "/var/www/datadock-deploy/current/server",
      script: "/home/ubuntu/.nvm/versions/node/v22.23.2/bin/npm",
      args: "run start",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      restart_delay: 3000,
    },
    {
      name: "datadock-client",
      cwd: "/var/www/datadock-deploy/current/client",
      script: "/home/ubuntu/.nvm/versions/node/v22.23.2/bin/npm",
      args: "run start",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
