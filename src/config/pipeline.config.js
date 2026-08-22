import path from "node:path";

const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArguments = process.platform === "win32"
  ? [
      process.env.npm_execpath ??
        path.join(
          path.dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js"
        ),
    ]
  : [];

export const PIPELINE_COMPONENTS = [
  {
    name: "server",
    directory: "server",
    stages: [
      {
        name: "install",
        status: "installing",
        command: npmCommand,
        args: [...npmArguments, "ci"],
        timeoutMs: 10 * 60 * 1000,
      },
    ],
  },
  {
    name: "client",
    directory: "client",
    stages: [
      {
        name: "install",
        status: "installing",
        command: npmCommand,
        args: [...npmArguments, "ci"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        name: "test",
        status: "testing",
        command: npmCommand,
        args: [...npmArguments, "test"],
        timeoutMs: 5 * 60 * 1000,
      },
      {
        name: "build",
        status: "building",
        command: npmCommand,
        args: [...npmArguments, "run", "build"],
        timeoutMs: 10 * 60 * 1000,
      },
    ],
  },
];
