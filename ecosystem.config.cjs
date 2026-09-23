const path = require("node:path");

const root = __dirname;
const bun = process.env.BUN_BIN || "bun";
const common = {
  FMS_DATA_ROOT: process.env.FMS_DATA_ROOT || path.join(root, "data"),
  TELEPORTER_SQLITE_PATH: process.env.TELEPORTER_SQLITE_PATH || path.join(root, "data", "teleporters.sqlite"),
  FMS_PORT_OFFSET: process.env.FMS_PORT_OFFSET || "0",
};

function bunApp(name, args, env = {}) {
  return {
    name,
    cwd: root,
    script: bun,
    args: `run ${args}`,
    interpreter: "none",
    exec_mode: "fork",
    autorestart: true,
    time: true,
    kill_timeout: 5000,
    env: { ...common, ...env },
  };
}

module.exports = {
  apps: [
    bunApp("fms-web", "web-client/src/server.ts"),
    bunApp("fms-yard-server", "server/src/index.ts", { FMS_MAP_ID: "yard" }),
    bunApp("fms-large-lab-server", "server/src/index.ts", { FMS_MAP_ID: "large_lab" }),
    // One process owns each physical robot. It starts in Yard and the
    // teleporter handoff switches its gRPC target to Large Lab as needed.
    bunApp("fms-robot-1", "virtual-robot/src/index.ts --id robot-1", { FMS_MAP_ID: "yard" }),
    bunApp("fms-robot-2", "virtual-robot/src/index.ts --id robot-2", { FMS_MAP_ID: "yard" }),
  ],
};
